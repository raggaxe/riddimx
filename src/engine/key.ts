/**
 * Musical key ("A#m", "F") from the notes that sound most in a track.
 * Spectrum peaks are folded into the 12 pitch classes and compared with the classic
 * Krumhansl major / minor profiles. Right most of the time, not always: relative keys
 * (C / Am) and fifths are the usual mix-ups.
 */
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

export class Chroma {
  frames = 0
  private sums = new Float64Array(12)

  /** One spectrum in dB (as an AnalyserNode gives it); `binHz` = frequency step between bins. */
  add(db: Float32Array, binHz: number): void {
    const from = Math.max(2, Math.ceil(110 / binHz))
    const to = Math.min(db.length - 1, Math.floor(2000 / binHz))
    let peak = -Infinity
    for (let i = from; i < to; i++) if (db[i] > peak) peak = db[i]
    if (!(peak > -75)) return // silence
    const frame = new Float64Array(12)
    let total = 0
    for (let i = from; i < to; i++) {
      // Only clear spectral peaks count: they are notes, the rest is mostly drums and noise.
      if (db[i] < peak - 40 || db[i] <= db[i - 1] || db[i] < db[i + 1]) continue
      const magnitude = Math.pow(10, db[i] / 20)
      const pitch = Math.round(12 * Math.log2((i * binHz) / 440)) + 69 // MIDI note number
      frame[((pitch % 12) + 12) % 12] += magnitude
      total += magnitude
    }
    if (total <= 0) return
    for (let i = 0; i < 12; i++) this.sums[i] += frame[i] / total
    this.frames++
  }

  key(): string | null {
    if (this.frames < 8) return null
    const mean = this.sums.reduce((a, b) => a + b, 0) / 12
    const correlate = (profile: number[], tonic: number): number => {
      const pMean = profile.reduce((a, b) => a + b, 0) / 12
      let num = 0
      let da = 0
      let db = 0
      for (let i = 0; i < 12; i++) {
        const x = this.sums[(i + tonic) % 12] - mean
        const y = profile[i] - pMean
        num += x * y
        da += x * x
        db += y * y
      }
      return num / Math.sqrt(da * db || 1)
    }
    let best = ''
    let top = -Infinity
    for (let tonic = 0; tonic < 12; tonic++) {
      const major = correlate(MAJOR, tonic)
      const minor = correlate(MINOR, tonic)
      if (major > top) {
        top = major
        best = NAMES[tonic]
      }
      if (minor > top) {
        top = minor
        best = NAMES[tonic] + 'm'
      }
    }
    return best || null
  }

  clear(): void {
    this.sums.fill(0)
    this.frames = 0
  }
}

/** Spectrum reader for a live sound (a clip being played or scanned). */
export class LiveChroma {
  readonly chroma = new Chroma()
  private analyser: AnalyserNode
  private data: Float32Array<ArrayBuffer>

  constructor(ctx: AudioContext, source: AudioNode) {
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 16384
    this.analyser.smoothingTimeConstant = 0
    source.connect(this.analyser)
    this.data = new Float32Array(this.analyser.frequencyBinCount)
  }

  /** Take one reading of what is sounding now. */
  sample(): void {
    this.analyser.getFloatFrequencyData(this.data)
    this.chroma.add(this.data, this.analyser.context.sampleRate / this.analyser.fftSize)
  }
}

/** Key of a decoded file: one minute from after the intro, read four times a second. */
export async function detectKey(buffer: AudioBuffer): Promise<string | null> {
  const rate = 22050
  const from = Math.min(buffer.duration * 0.2, 30)
  const seconds = Math.min(60, buffer.duration - from)
  if (seconds < 4) return null
  try {
    const ctx = new OfflineAudioContext(1, Math.floor(rate * seconds), rate)
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 8192
    analyser.smoothingTimeConstant = 0
    source.connect(analyser)
    analyser.connect(ctx.destination)
    source.start(0, from, seconds)
    const chroma = new Chroma()
    const data = new Float32Array(analyser.frequencyBinCount)
    for (let t = 0.5; t < seconds; t += 0.25) {
      void ctx.suspend(t).then(() => {
        analyser.getFloatFrequencyData(data)
        chroma.add(data, rate / analyser.fftSize)
        void ctx.resume()
      })
    }
    await ctx.startRendering()
    return chroma.key()
  } catch {
    return null
  }
}

const LS = 'vx_key'

function all(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

/** Remembered keys of streaming tracks, by track ref. */
export const keyStore = {
  get: (ref: string): string | null => all()[ref] ?? null,
  set(ref: string, key: string): void {
    localStorage.setItem(LS, JSON.stringify({ ...all(), [ref]: key }))
  },
}

const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'] // C, C#, D …
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'] // Cm, C#m, Dm …

/** Camelot wheel code of a key ("Am" → "8A"): neighbours on the wheel mix without clashing. */
export function camelot(key: string | null): string | null {
  if (!key) return null
  const minor = key.endsWith('m')
  const tonic = NAMES.indexOf(minor ? key.slice(0, -1) : key)
  return tonic < 0 ? null : (minor ? CAMELOT_MINOR : CAMELOT_MAJOR)[tonic]
}

/** Do two keys sit well together? Same key, one step round the wheel, or relative major/minor. */
export function harmonic(a: string | null, b: string | null): boolean {
  const x = camelot(a)
  const y = camelot(b)
  if (!x || !y) return false
  const nx = parseInt(x)
  const ny = parseInt(y)
  const sameLetter = x.slice(-1) === y.slice(-1)
  if (nx === ny) return true
  const step = Math.min((nx - ny + 12) % 12, (ny - nx + 12) % 12)
  return sameLetter && step === 1
}

/** The key moved by whole semitones ("Am", +2 → "Bm"): what a record sounds in when sped up without key lock. */
export function transpose(key: string | null, semitones: number): string | null {
  if (!key || !semitones) return key
  const minor = key.endsWith('m')
  const tonic = NAMES.indexOf(minor ? key.slice(0, -1) : key)
  if (tonic < 0) return key
  return NAMES[(((tonic + semitones) % 12) + 12) % 12] + (minor ? 'm' : '')
}
