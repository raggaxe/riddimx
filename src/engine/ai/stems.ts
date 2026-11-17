import { SAMPLE_RATE, SOURCES, type Source } from './demucs'

/**
 * The built-in stem separator, as the decks use it: one track at a time (each one takes the whole
 * GPU), resampled to 44.1 kHz first. The model file ships with the app.
 */

let worker: Worker | null = null
let queue: Promise<unknown> = Promise.resolve()
let jobs = 0

/** Which engine the last separation ran on ('GPU' or 'CPU'), for the status line. */
export let stemsEngine: string | null = null

async function to441(buffer: AudioBuffer): Promise<[Float32Array, Float32Array]> {
  if (buffer.sampleRate === SAMPLE_RATE && buffer.numberOfChannels >= 2)
    return [buffer.getChannelData(0).slice(), buffer.getChannelData(1).slice()]
  const length = Math.ceil(buffer.duration * SAMPLE_RATE)
  const ctx = new OfflineAudioContext(2, length, SAMPLE_RATE)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start()
  const out = await ctx.startRendering()
  return [out.getChannelData(0).slice(), out.getChannelData(1).slice()]
}

/** Separates `buffer` into drums, bass, other and vocals: interleaved stereo float32 at 44.1 kHz. */
export function separateStems(buffer: AudioBuffer, onProgress: (p: number) => void): Promise<Record<Source, Float32Array>> {
  const id = 'job' + ++jobs
  const job = queue.then(async () => {
    const [left, right] = await to441(buffer)
    worker ??= new Worker(new URL('./stems.worker.ts', import.meta.url), { type: 'module' })
    const w = worker
    return new Promise<Record<Source, Float32Array>>((resolve, reject) => {
      const listen = (e: MessageEvent) => {
        const m = e.data
        if (m.id !== id) return
        if (m.engine) stemsEngine = m.engine
        if (typeof m.progress === 'number') onProgress(m.progress)
        if (m.stems) {
          w.removeEventListener('message', listen)
          resolve(m.stems)
        }
        if (m.error) {
          w.removeEventListener('message', listen)
          reject(new Error(m.error))
        }
      }
      w.addEventListener('message', listen)
      w.postMessage({ id, left, right }, [left.buffer, right.buffer])
    })
  })
  queue = job.catch(() => undefined)
  return job
}

export { SOURCES, SAMPLE_RATE }
