/** Normalised overview peaks for waveform drawing. */
export function computePeaks(buf: AudioBuffer, buckets = 1000): Float32Array {
  const a = buf.getChannelData(0)
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a
  const step = Math.max(1, Math.floor(a.length / buckets))
  const stride = Math.max(1, Math.floor(step / 200))
  const peaks = new Float32Array(buckets)
  let top = 0
  for (let i = 0; i < buckets; i++) {
    let max = 0
    const end = Math.min(a.length, (i + 1) * step)
    for (let j = i * step; j < end; j += stride) {
      const v = Math.abs(a[j] + b[j]) * 0.5
      if (v > max) max = v
    }
    peaks[i] = max
    if (max > top) top = max
  }
  if (top > 0) for (let i = 0; i < buckets; i++) peaks[i] /= top
  return peaks
}

export interface Tempo {
  bpm: number
  /** Beat-periodicity strength, roughly 0 (noise/speech) … 1 (metronome). */
  confidence: number
}

/**
 * Tempo from a loudness envelope sampled at `rate` Hz.
 * 1. onset strength = positive envelope slope
 * 2. autocorrelation over 75–180 BPM, weighted towards ~125 BPM to break half/double ties
 * 3. refine the beat period on its 2nd and 4th multiples (4× finer lag resolution)
 */
export function tempoFromEnvelope(env: Float32Array, rate: number): Tempo | null {
  const n = env.length
  if (n < rate * 6) return null
  const onset = new Float32Array(n)
  let mean = 0
  for (let i = 1; i < n; i++) {
    const d = env[i] - env[i - 1]
    if (d > 0) {
      onset[i] = d
      mean += d
    }
  }
  mean /= n
  // Remove the mean so a steady stream of random onsets (speech, noise) correlates to ~0.
  let energy = 0
  for (let i = 0; i < n; i++) {
    onset[i] -= mean
    energy += onset[i] * onset[i]
  }
  if (energy <= 0) return null

  const cache = new Map<number, number>()
  const ac = (lag: number): number => {
    let v = cache.get(lag)
    if (v === undefined) {
      let sum = 0
      for (let i = 0; i + lag < n; i++) sum += onset[i] * onset[i + lag]
      v = sum / (n - lag)
      cache.set(lag, v)
    }
    return v
  }
  /** Highest autocorrelation within ±radius of `center`, with parabolic sub-lag interpolation. */
  const peakNear = (center: number, radius: number): number => {
    let best = center
    for (let lag = center - radius; lag <= center + radius; lag++) if (ac(lag) > ac(best)) best = lag
    const y0 = ac(best - 1)
    const y1 = ac(best)
    const y2 = ac(best + 1)
    const denom = y0 - 2 * y1 + y2
    const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0
    return best + Math.max(-0.5, Math.min(0.5, shift))
  }

  const minLag = Math.floor((rate * 60) / 180)
  const maxLag = Math.ceil((rate * 60) / 75)
  let bestLag = 0
  let bestScore = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const octaves = Math.log2((60 * rate) / lag / 125)
    const score = ac(lag) * Math.exp(-0.5 * (octaves / 0.7) ** 2)
    if (score > bestScore) {
      bestScore = score
      bestLag = lag
    }
  }
  if (!bestLag) return null
  const confidence = ac(bestLag) / (energy / n)

  let period = peakNear(bestLag, 0)
  for (const multiple of [2, 4]) {
    const center = Math.round(period * multiple)
    if (center + 4 >= n / 2) break
    period = peakNear(center, 2) / multiple
  }

  let bpm = (60 * rate) / period
  // Most produced music sits on a whole BPM: snap when we are within measurement error.
  if (Math.abs(bpm - Math.round(bpm)) < 0.12) bpm = Math.round(bpm)
  return { bpm: Math.round(bpm * 10) / 10, confidence }
}

/**
 * Tempo of decoded audio. By default uses up to 90 s starting after the intro;
 * `whole` analyses everything from the start (short preview clips).
 */
export function detectTempo(buf: AudioBuffer, whole = false): Tempo | null {
  const sr = buf.sampleRate
  const data = buf.getChannelData(0)
  const hop = Math.round(sr / 500)
  const start = whole ? 0 : Math.floor(Math.min(data.length * 0.2, 30 * sr))
  const len = Math.min(data.length - start, 90 * sr)
  const n = Math.floor(len / hop)
  if (n <= 0) return null
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const base = start + i * hop
    for (let j = 0; j < hop; j++) {
      const v = data[base + j]
      sum += v * v
    }
    env[i] = Math.sqrt(sum / hop)
  }
  return tempoFromEnvelope(env, sr / hop)
}

/** BPM of a decoded file: a minute of music from after the intro, scanned beat by beat. */
export function detectBpm(buf: AudioBuffer): number | null {
  const sr = buf.sampleRate
  const data = buf.getChannelData(0)
  const hop = Math.round(sr / 500)
  const start = Math.floor(Math.min(data.length * 0.2, 30 * sr))
  const n = Math.floor(Math.min(data.length - start, 60 * sr) / hop)
  if (n <= 0) return null
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    const base = start + i * hop
    for (let j = 0; j < hop; j++) {
      const v = data[base + j]
      sum += v * v
    }
    env[i] = Math.sqrt(sum / hop)
  }
  const found = scanTempo(env, sr / hop)
  // No clear beat at all: fall back to the autocorrelation estimate.
  return found && found.strength >= 1.6 ? found.bpm : (detectTempo(buf)?.bpm ?? null)
}

/**
 * Position (seconds) of one beat, i.e. the phase of the beat grid for a known BPM.
 * Slides a pulse train with the beat period over the onset envelope and keeps the best fit.
 */
export function detectBeatAnchor(buf: AudioBuffer, bpm: number): number {
  const sr = buf.sampleRate
  const data = buf.getChannelData(0)
  const hop = Math.round(sr / 500)
  const rate = sr / hop
  const start = Math.floor(Math.min(data.length * 0.2, 30 * sr))
  const n = Math.floor(Math.min(data.length - start, 40 * sr) / hop)
  const onset = new Float32Array(Math.max(n, 1))
  let prev = 0
  for (let i = 0; i < n; i++) {
    let sum = 0
    const base = start + i * hop
    for (let j = 0; j < hop; j++) {
      const v = data[base + j]
      sum += v * v
    }
    const env = Math.sqrt(sum / hop)
    if (i > 0 && env > prev) onset[i] = env - prev
    prev = env
  }
  const beat = (60 / bpm) * rate // beat period in envelope samples
  let bestOffset = 0
  let bestScore = -1
  for (let offset = 0; offset < beat; offset++) {
    let score = 0
    for (let k = 0; ; k++) {
      const i = Math.round(offset + k * beat)
      if (i >= n) break
      score += onset[i] + 0.5 * ((onset[i - 1] || 0) + (onset[i + 1] || 0))
    }
    if (score > bestScore) {
      bestScore = score
      bestOffset = offset
    }
  }
  return start / sr + bestOffset / rate
}

/**
 * Where the bars start: of the four beats of a bar, the one where the low end (kick and bass) hits
 * hardest is taken as the one. Returns the first bar head of the track (0 ≤ t < one bar), on the
 * grid given by `anchor`. A guess: the DJ can put the one elsewhere (Shift+TAP).
 */
export function detectDownbeat(buf: AudioBuffer, bpm: number, anchor: number): number {
  const sr = buf.sampleRate
  const left = buf.getChannelData(0)
  const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left
  const beat = 60 / bpm
  const bar = 4 * beat
  const hop = Math.round(sr / 200)
  const n = Math.floor(Math.min(left.length, 240 * sr) / hop)
  // Low band (below ≈150 Hz) loudness per hop, then its rises (onsets).
  const k = 1 - Math.exp((-2 * Math.PI * 150) / sr)
  let lp = 0
  const env = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let sum = 0
    for (let j = i * hop, end = j + hop; j < end; j++) {
      lp += k * ((left[j] + right[j]) * 0.5 - lp)
      sum += lp * lp
    }
    env[i] = Math.sqrt(sum / hop)
  }
  const rate = sr / hop
  const score = [0, 0, 0, 0]
  const first = anchor - Math.floor(anchor / beat) * beat
  for (let b = 0; ; b++) {
    const t = first + b * beat
    const i = Math.round(t * rate)
    if (i + 4 >= n) break
    // Strongest rise within ±20 ms of the beat.
    let rise = 0
    for (let d = -4; d <= 4; d++) {
      const at = i + d
      if (at > 0 && at < n) rise = Math.max(rise, env[at] - env[at - 1])
    }
    score[b % 4] += rise
  }
  const best = score.indexOf(Math.max(...score))
  return first + best * beat - Math.floor((first + best * beat) / bar) * bar
}

/**
 * Beat phase inside a loudness envelope for a known beat period (in envelope samples):
 * slides a pulse train over the onset strength. `offset` is the index of the first beat;
 * `strength` compares the best alignment with the average one (≈1 = no audible beat).
 */
export function beatPhase(
  env: Float32Array,
  period: number,
): { offset: number; strength: number; /** strength of every possible offset */ all: Float32Array } {
  const n = env.length
  const onset = new Float32Array(n)
  for (let i = 1; i < n; i++) if (env[i] > env[i - 1]) onset[i] = env[i] - env[i - 1]
  const steps = Math.max(1, Math.floor(period))
  let best = 0
  let bestScore = -1
  let total = 0
  const all = new Float32Array(steps)
  for (let offset = 0; offset < steps; offset++) {
    let score = 0
    for (let k = 0; ; k++) {
      const i = Math.round(offset + k * period)
      if (i >= n) break
      score += onset[i] + 0.5 * ((onset[i - 1] || 0) + (onset[i + 1] || 0))
    }
    total += score
    all[offset] = score
    if (score > bestScore) {
      bestScore = score
      best = offset
    }
  }
  const mean = total / steps
  for (let i = 0; i < steps; i++) all[i] = mean > 0 ? all[i] / mean : 0
  return { offset: best, strength: mean > 0 ? bestScore / mean : 0, all }
}

/**
 * Sharpens a tempo estimate: tries every tempo within ±span of `bpm` and keeps the one whose
 * beat grid lines up best with the onsets over the whole envelope. Over 20–30 s this pins the
 * tempo to a few hundredths of a BPM; `strength` (see beatPhase) tells whether a steady beat exists.
 */
export function refineTempo(env: Float32Array, rate: number, bpm: number, span: number): { bpm: number; strength: number } {
  let best = bpm
  let top = 0
  const scan = (from: number, to: number, step: number): void => {
    for (let candidate = from; candidate <= to; candidate += step) {
      const strength = beatPhase(env, (60 / candidate) * rate).strength
      if (strength > top) {
        top = strength
        best = candidate
      }
    }
  }
  scan(bpm * (1 - span), bpm * (1 + span), 0.05)
  scan(best - 0.05, best + 0.05, 0.01)
  return { bpm: best, strength: top }
}

/** Fine waveform for the zoomed, scrolling view: `rate` peaks per second, scaled to 0..1. */
export function computeDetail(buf: AudioBuffer, rate = 100): Float32Array {
  const a = buf.getChannelData(0)
  const b = buf.numberOfChannels > 1 ? buf.getChannelData(1) : a
  const hop = buf.sampleRate / rate
  const n = Math.ceil(a.length / hop)
  const out = new Float32Array(n)
  let top = 0
  for (let i = 0; i < n; i++) {
    const end = Math.min(a.length, Math.floor((i + 1) * hop))
    let max = 0
    for (let j = Math.floor(i * hop); j < end; j += 4) {
      const v = Math.abs(a[j] + b[j]) * 0.5
      if (v > max) max = v
    }
    out[i] = max
    if (max > top) top = max
  }
  if (top > 0) for (let i = 0; i < n; i++) out[i] /= top
  return out
}

/**
 * Tempo by brute force: tries every tempo from `lo` to `hi` and keeps the one whose beat grid
 * lines up best with the onsets. Slower than tempoFromEnvelope but not fooled by syncopation,
 * such as the off-beat skank and "one drop" of reggae.
 */
export function scanTempo(env: Float32Array, rate: number, lo = 70, hi = 180): { bpm: number; strength: number } | null {
  if (env.length < rate * 6) return null
  let best = 0
  let top = 0
  for (let bpm = lo; bpm <= hi; bpm += 0.5) {
    const strength = beatPhase(env, (60 / bpm) * rate).strength
    if (strength > top) {
      top = strength
      best = bpm
    }
  }
  if (!best) return null
  const fine = refineTempo(env, rate, best, 0.006)
  let value = fine.bpm
  value = Math.abs(value - Math.round(value)) < 0.12 ? Math.round(value) : Math.round(value * 10) / 10
  return { bpm: value, strength: fine.strength }
}
