import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { DEFAULT_PADS, sfx, sfxLabel } from './soundsystem'

/**
 * Eight sample pads (jingles, effects, drops). Each pad holds a sound-system effect that comes with
 * the app or an audio file of the user's, and plays it into the master mix. Pads are kept in the
 * browser's IndexedDB, so they are still there next time.
 */
export const PADS = 8

export interface SamplerState {
  pads: { name: string | null; playing: boolean; duration: number }[]
  volume: number
}

const DB = 'vx-sampler'
const STORE = 'pads'

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error)
  })
}

async function dbRun<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const base = await db()
  return new Promise((resolve, reject) => {
    const request = run(base.transaction(STORE, mode).objectStore(STORE))
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

class Sampler extends Store<SamplerState> {
  private out: GainNode
  private buffers: (AudioBuffer | null)[] = Array(PADS).fill(null)
  private sources: (AudioBufferSourceNode | null)[] = Array(PADS).fill(null)

  constructor() {
    super({ pads: Array.from({ length: PADS }, () => ({ name: null, playing: false, duration: 0 })), volume: 0.8 })
    this.out = mixer.ctx.createGain()
    this.out.gain.value = this.state.volume
    this.out.connect(mixer.masterGain)
    void this.restore()
  }

  private patch(index: number, change: Partial<SamplerState['pads'][number]>): void {
    this.set({ pads: this.state.pads.map((p, i) => (i === index ? { ...p, ...change } : p)) })
  }

  private async restore(): Promise<void> {
    for (let i = 0; i < PADS; i++) {
      try {
        type Saved = { name: string; data?: ArrayBuffer; sfx?: string; cleared?: boolean }
        const saved = await dbRun<Saved | undefined>('readonly', (s) => s.get(i))
        if (saved?.cleared) continue
        // A pad nobody has touched holds its default sound-system effect.
        const bundled = saved ? saved.sfx : DEFAULT_PADS[i]
        if (bundled) {
          this.buffers[i] = await sfx(bundled)
          this.patch(i, { name: sfxLabel(bundled), duration: this.buffers[i]!.duration })
          continue
        }
        if (!saved?.data) continue
        this.buffers[i] = await mixer.ctx.decodeAudioData(saved.data.slice(0))
        this.patch(i, { name: saved.name, duration: this.buffers[i]!.duration })
      } catch {
        /* a pad that cannot be restored simply stays empty */
      }
    }
  }

  /** Put one of the app's sound-system effects on a pad. */
  async assign(index: number, id: string): Promise<boolean> {
    try {
      const buffer = await sfx(id)
      this.stop(index)
      this.buffers[index] = buffer
      this.patch(index, { name: sfxLabel(id), duration: buffer.duration })
      await dbRun('readwrite', (s) => s.put({ name: sfxLabel(id), sfx: id }, index)).catch(() => undefined)
      return true
    } catch {
      return false
    }
  }

  /** Listen to an effect before using it: in the headphones when they are set up, otherwise in the mix. */
  async preview(id: string): Promise<void> {
    const buffer = await sfx(id).catch(() => null)
    if (!buffer) return
    mixer.resume()
    const source = mixer.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(mixer.get().hpDevice ? mixer.cueBus : this.out)
    source.start()
  }

  private previewing: AudioBufferSourceNode | null = null

  /** Listen to a sound that is not on a pad yet (a new drop); calling again stops the last one first. */
  previewBuffer(buffer: AudioBuffer, onEnd?: () => void): void {
    this.stopPreview()
    mixer.resume()
    const source = mixer.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(mixer.get().hpDevice ? mixer.cueBus : this.out)
    source.onended = () => {
      if (this.previewing === source) this.previewing = null
      onEnd?.()
    }
    this.previewing = source
    source.start()
  }

  stopPreview(): void {
    const s = this.previewing
    this.previewing = null
    if (s) {
      s.onended?.(new Event('ended'))
      s.onended = null
      s.stop()
    }
  }

  /** Put an audio file on a pad. */
  async load(index: number, file: File): Promise<boolean> {
    try {
      const data = await file.arrayBuffer()
      const buffer = await mixer.ctx.decodeAudioData(data.slice(0))
      this.stop(index)
      this.buffers[index] = buffer
      const name = file.name.replace(/\.[^.]+$/, '')
      this.patch(index, { name, duration: buffer.duration })
      await dbRun('readwrite', (s) => s.put({ name, data }, index)).catch(() => undefined)
      return true
    } catch {
      return false
    }
  }

  clear(index: number): void {
    this.stop(index)
    this.buffers[index] = null
    this.patch(index, { name: null, duration: 0 })
    // Remembered as emptied, so a built-in effect does not come back on its own.
    void dbRun('readwrite', (s) => s.put({ cleared: true }, index)).catch(() => undefined)
  }

  /** Where the pads sound: straight into the master, or through another input (the Dub Box). */
  route(node: AudioNode | null): void {
    this.out.disconnect()
    this.out.connect(node ?? mixer.masterGain)
  }

  /** Pad pressed: plays from the start; pressed again while it sounds, stops it. */
  trigger(index: number): void {
    const buffer = this.buffers[index]
    if (!buffer) return
    mixer.resume()
    if (this.sources[index]) {
      this.stop(index)
      return
    }
    const source = mixer.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.out)
    source.onended = () => {
      if (this.sources[index] === source) {
        this.sources[index] = null
        this.patch(index, { playing: false })
      }
    }
    this.sources[index] = source
    source.start()
    this.patch(index, { playing: true })
  }

  /** Play a sound once into the mix, outside the pads (e.g. the rewind's shout). */
  async shout(id: string): Promise<void> {
    const buffer = await sfx(id).catch(() => null)
    if (!buffer) return
    const source = mixer.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.out)
    source.start()
  }

  stop(index: number): void {
    const source = this.sources[index]
    if (!source) return
    this.sources[index] = null
    source.onended = null
    source.stop()
    this.patch(index, { playing: false })
  }

  /** Silence every pad at once. */
  stopAll(): void {
    for (let i = 0; i < PADS; i++) this.stop(i)
  }

  setVolume(v: number): void {
    this.set({ volume: clamp(v, 0, 1) })
    this.out.gain.setTargetAtTime(this.state.volume, mixer.ctx.currentTime, 0.01)
  }
}

export const sampler = new Sampler()
