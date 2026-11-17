/**
 * Riddims: the same instrumental under different songs. A riddim is recognised by what its versions
 * share, measured on every eighth note of the middle of the track:
 *  · which notes the bass plays, and how the bass line moves from one note to the next;
 *  · which notes the harmony (keys, guitar skank) sits on;
 *  · the rhythm of the low end (how the kick and bass hits repeat).
 * All of it is independent of where in the song you start, so two versions line up without aligning them.
 */

const RATE = 11025
const N = 4096 // FFT size: 0.37 s, enough resolution for bass notes

export interface RiddimPrint {
  bpm: number
  bass: number[] // 12, average bass chroma
  harm: number[] // 12, average harmony chroma
  moves: number[] // 144, bass note → next bass note, normalised
  groove: number[] // 16, low-end self-similarity at 1..16 eighths
}

/** In-place radix-2 FFT (real input in re, zeros in im). */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

const norm = (v: number[]): number[] => {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
  return v.map((x) => x / len)
}

/** Measures a track (decoded audio and its BPM). Null when too short or without a tempo. */
export async function riddimPrint(buffer: AudioBuffer, bpm: number | null): Promise<RiddimPrint | null> {
  if (!bpm || buffer.duration < 40) return null
  // Mono at 11 kHz, the middle 60% of the song (skips intros and fades).
  const from = buffer.duration * 0.2
  const length = buffer.duration * 0.6
  const ctx = new OfflineAudioContext(1, Math.floor(length * RATE), RATE)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start(0, from, length)
  const x = (await ctx.startRendering()).getChannelData(0)

  const step = Math.round((60 / bpm / 2) * RATE) // one eighth note
  const window = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)))
  const re = new Float32Array(N)
  const im = new Float32Array(N)
  const binHz = RATE / N
  const bassSeq: number[] = []
  const low: number[] = []
  const bass = new Array(12).fill(0)
  const harm = new Array(12).fill(0)
  let frames = 0
  for (let at = 0; at + N < x.length; at += step) {
    for (let i = 0; i < N; i++) {
      re[i] = x[at + i] * window[i]
      im[i] = 0
    }
    fft(re, im)
    const b = new Array(12).fill(0)
    const h = new Array(12).fill(0)
    let lowEnergy = 0
    for (let k = 3; k < N / 2; k++) {
      const hz = k * binHz
      if (hz > 2000) break
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      if (hz < 150) lowEnergy += mag
      const pc = ((Math.round(12 * Math.log2(hz / 440)) % 12) + 12 + 9) % 12 // 0 = C
      if (hz >= 40 && hz < 200) b[pc] += mag
      else if (hz >= 200) h[pc] += mag
    }
    for (let i = 0; i < 12; i++) {
      bass[i] += b[i]
      harm[i] += h[i]
    }
    const loud = Math.max(...b)
    bassSeq.push(loud > 0 ? b.indexOf(loud) : -1)
    low.push(lowEnergy)
    frames++
  }
  if (frames < 64) return null

  // Bass line moves: how often each note goes to each other note (repeats count too).
  const moves = new Array(144).fill(0)
  for (let i = 1; i < bassSeq.length; i++) if (bassSeq[i - 1] >= 0 && bassSeq[i] >= 0) moves[bassSeq[i - 1] * 12 + bassSeq[i]]++

  // Groove: how much the low end repeats itself 1..16 eighths later (a 2-bar cycle).
  const mean = low.reduce((s, v) => s + v, 0) / low.length
  const dev = low.map((v) => v - mean)
  const energy = dev.reduce((s, v) => s + v * v, 0) || 1
  const groove = Array.from({ length: 16 }, (_, lag) => {
    let s = 0
    for (let i = lag + 1; i < dev.length; i++) s += dev[i] * dev[i - lag - 1]
    return s / energy
  })

  const round = (v: number[]) => v.map((n) => Math.round(n * 1000) / 1000)
  return { bpm, bass: round(norm(bass)), harm: round(norm(harm)), moves: round(norm(moves)), groove: round(groove) }
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0)
/** A 12-note vector moved up by `t` semitones. */
const rot = (v: number[], t: number) => v.map((_, i) => v[(i - t + 12) % 12])
/** The bass-move table moved up by `t` semitones. */
const rotMoves = (m: number[], t: number) => m.map((_, i) => m[((Math.floor(i / 12) - t + 12) % 12) * 12 + ((i % 12) - t + 12) % 12])

/** 0..1: how sure we are two tracks share a riddim. Versions may be pitched up or down a semitone or two. */
export function riddimMatch(a: RiddimPrint, b: RiddimPrint): number {
  // Same tempo (within 4%), or one at half / double tempo.
  const ratio = a.bpm / b.bpm
  const tempo = [1, 2, 0.5].some((r) => Math.abs(ratio / r - 1) < 0.04)
  if (!tempo) return 0
  let best = 0
  for (const t of [0, 1, -1, 2, -2]) {
    const bass = dot(a.bass, rot(b.bass, t))
    const harm = dot(a.harm, rot(b.harm, t))
    const moves = dot(a.moves, rotMoves(b.moves, t))
    best = Math.max(best, 0.35 * moves + 0.35 * bass + 0.3 * harm)
  }
  const groove = 1 - Math.min(1, a.groove.reduce((s, g, i) => s + Math.abs(g - b.groove[i]), 0) / 6)
  return best * (0.8 + 0.2 * groove)
}

/** Above this, two tracks are put in the same riddim. */
export const RIDDIM_THRESHOLD = 0.8

/** Groups tracks whose prints match (a version matching any member joins the group). */
export function groupRiddims(prints: Record<string, RiddimPrint>): string[][] {
  const ids = Object.keys(prints)
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id: string): string => (parent.get(id) === id ? id : find(parent.get(id)!))
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++)
      if (riddimMatch(prints[ids[i]], prints[ids[j]]) >= RIDDIM_THRESHOLD) parent.set(find(ids[i]), find(ids[j]))
  const groups = new Map<string, string[]>()
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id])
  return [...groups.values()].filter((g) => g.length > 1)
}
