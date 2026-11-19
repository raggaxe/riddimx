import { Store } from '../store'
import { mixer } from './mixer'
import { toWav } from './drops'

/**
 * My drops: every drop the DJ keeps (typed, spoken into the mic, or cut from a track) is stored in
 * the app as a WAV, so it can be heard, put on a pad or exported again in any later set.
 */
export interface SavedDrop {
  id: string
  name: string
  duration: number // seconds
  created: number // ms since 1970
}

interface Row extends SavedDrop {
  wav: ArrayBuffer
}

const DB = 'vx-drops'
const STORE = 'drops'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

class MyDrops extends Store<{ list: SavedDrop[] }> {
  constructor() {
    super({ list: [] })
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    try {
      const rows = await run<Row[]>('readonly', (s) => s.getAll())
      const list = rows.map(({ id, name, duration, created }) => ({ id, name, duration, created }))
      this.set({ list: list.sort((a, b) => b.created - a.created) })
    } catch {
      /* storage unavailable: the list stays empty */
    }
  }

  /** Keeps this drop. The same sound saved twice in a row is kept once. */
  async save(name: string, buffer: AudioBuffer): Promise<SavedDrop | null> {
    const wav = toWav(buffer)
    const last = this.state.list[0]
    if (last && last.name === name && Math.abs(last.duration - buffer.duration) < 0.005) return last
    const row: Row = { id: crypto.randomUUID(), name, duration: buffer.duration, created: Date.now(), wav: wav.buffer }
    try {
      await run('readwrite', (s) => s.put(row))
    } catch {
      return null
    }
    await this.refresh()
    return row
  }

  async rename(id: string, name: string): Promise<void> {
    const clean = name.trim().slice(0, 40)
    if (!clean) return
    try {
      const row = await run<Row | undefined>('readonly', (s) => s.get(id))
      if (!row) return
      await run('readwrite', (s) => s.put({ ...row, name: clean }))
    } catch {
      return
    }
    await this.refresh()
  }

  async remove(id: string): Promise<void> {
    try {
      await run('readwrite', (s) => s.delete(id))
    } catch {
      /* already gone */
    }
    await this.refresh()
  }

  async wav(id: string): Promise<Uint8Array | null> {
    try {
      const row = await run<Row | undefined>('readonly', (s) => s.get(id))
      return row ? new Uint8Array(row.wav) : null
    } catch {
      return null
    }
  }

  async buffer(id: string): Promise<AudioBuffer | null> {
    const wav = await this.wav(id)
    return wav ? mixer.ctx.decodeAudioData(wav.slice().buffer) : null
  }
}

export const myDrops = new MyDrops()
