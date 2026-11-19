/**
 * Integrated loudness (LUFS) of a decoded track, after ITU-R BS.1770: K-weighting (a high shelf
 * for how the head hears, a high-pass for the rumble), mean power in 400 ms blocks every 100 ms,
 * an absolute gate at -70 LUFS and a relative gate 10 LU under the gated average.
 */

type Biquad = [number, number, number, number, number] // b0 b1 b2 a1 a2, normalised by a0

function shelf(fs: number): Biquad {
  const G = 4
  const Q = Math.SQRT1_2
  const fc = 1500
  const A = Math.pow(10, G / 40)
  const w = (2 * Math.PI * fc) / fs
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Q)
  const s = 2 * Math.sqrt(A) * alpha
  const a0 = A + 1 - (A - 1) * cos + s
  return [
    (A * (A + 1 + (A - 1) * cos + s)) / a0,
    (-2 * A * (A - 1 + (A + 1) * cos)) / a0,
    (A * (A + 1 + (A - 1) * cos - s)) / a0,
    (2 * (A - 1 - (A + 1) * cos)) / a0,
    (A + 1 - (A - 1) * cos - s) / a0,
  ]
}

function highpass(fs: number): Biquad {
  const Q = 0.5
  const fc = 38
  const w = (2 * Math.PI * fc) / fs
  const cos = Math.cos(w)
  const alpha = Math.sin(w) / (2 * Q)
  const a0 = 1 + alpha
  return [(1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0]
}

/** LUFS of the whole track, or null for silence. Mono and stereo; extra channels are left out. */
export function integratedLufs(buffer: AudioBuffer): number | null {
  const fs = buffer.sampleRate
  const seg = Math.round(fs * 0.1) // 100 ms
  const segs = Math.floor(buffer.length / seg)
  if (segs < 4) return null
  const power = new Float64Array(segs) // sum of K-weighted squares per 100 ms, all channels
  const [s0, s1, s2, s3, s4] = shelf(fs)
  const [h0, h1, h2, h3, h4] = highpass(fs)
  for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) {
    const x = buffer.getChannelData(c)
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0 // shelf state
    let u1 = 0, u2 = 0, z1 = 0, z2 = 0 // high-pass state
    for (let k = 0; k < segs; k++) {
      let sum = 0
      const end = (k + 1) * seg
      for (let i = k * seg; i < end; i++) {
        const xi = x[i]
        const y = s0 * xi + s1 * x1 + s2 * x2 - s3 * y1 - s4 * y2
        x2 = x1
        x1 = xi
        y2 = y1
        y1 = y
        const z = h0 * y + h1 * u1 + h2 * u2 - h3 * z1 - h4 * z2
        u2 = u1
        u1 = y
        z2 = z1
        z1 = z
        sum += z * z
      }
      power[k] += sum
    }
  }
  // 400 ms blocks with 75 % overlap: four segments each.
  const blocks: number[] = []
  for (let k = 0; k + 4 <= segs; k++) blocks.push((power[k] + power[k + 1] + power[k + 2] + power[k + 3]) / (4 * seg))
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p)
  const loud = blocks.filter((p) => p > 0 && lufs(p) > -70)
  if (!loud.length) return null
  const gate = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10
  const kept = loud.filter((p) => lufs(p) > gate)
  return lufs(kept.reduce((a, b) => a + b, 0) / kept.length)
}

/** The loudness every track is brought to when matching is on. */
export const LUFS_TARGET = -14
/** How far a track is turned down or up to get there (quiet intros and huge masters stay sane). */
export const MATCH_RANGE = [-12, 9] as const

export const matchDb = (lufs: number | null): number =>
  lufs === null ? 0 : Math.max(MATCH_RANGE[0], Math.min(MATCH_RANGE[1], LUFS_TARGET - lufs))
