/**
 * RiddimX's built-in stem separator: Demucs htdemucs (drums, bass, other, vocals) run as an ONNX model
 * (htdemucs_ft was tried: cleaner on paper, worse to the ear here, and 4x slower),
 * with everything around the model done here, exactly as Demucs does it:
 *  · the mix is normalised, cut into 7.8 s segments that overlap by a quarter, and stitched back
 *    with triangular weights (demucs.apply.apply_model, split=True, overlap=0.25, shifts=0);
 *  · each segment's spectrogram (STFT 4096 / hop 1024, Hann, normalised) is made here and fed to the
 *    model with the waveform; the model's spectrogram output is turned back to sound (iSTFT) here and
 *    added to its waveform output (HTDemucs._spec / _ispec).
 * No DOM and no ONNX import: the caller passes `run`, so this works in a Web Worker and in Node tests.
 */

export const SAMPLE_RATE = 44100
/** The model file, and its name: stems saved by another model are separated again (electron/main.cjs). */
export const MODEL = 'htdemucs'
export const MODEL_URL = '/models/' + MODEL + '.onnx'
export const SOURCES = ['drums', 'bass', 'other', 'vocals'] as const
export type Source = (typeof SOURCES)[number]

const NFFT = 4096
const HOP = 1024
const BINS = NFFT / 2 // the model drops the Nyquist bin
const SEGMENT = Math.floor((39 / 5) * SAMPLE_RATE) // 343980 samples, the model's training length
const FRAMES = Math.ceil(SEGMENT / HOP) // 336
const OVERLAP = 0.25

const S = SOURCES.length

/** What the ONNX model does: mix [1,2,L] + mag [1,4,2048,T] → spec [1,S,4,2048,T] + wave [1,S,2,L] (S sources). */
export type RunModel = (mix: Float32Array, mag: Float32Array) => Promise<{ spec: Float32Array; wave: Float32Array }>

// ───────────── FFT (radix 2, in place, float64) ─────────────

const fftTables = (() => {
  const rev = new Uint32Array(NFFT)
  const bits = Math.log2(NFFT)
  for (let i = 0; i < NFFT; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(NFFT / 2)
  const sin = new Float64Array(NFFT / 2)
  for (let i = 0; i < NFFT / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / NFFT)
    sin[i] = Math.sin((2 * Math.PI * i) / NFFT)
  }
  // Periodic Hann window, as torch.hann_window(4096).
  const win = new Float64Array(NFFT)
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT)
  return { rev, cos, sin, win }
})()

/** Complex FFT of size NFFT; inverse = true gives the unscaled inverse (no 1/N). */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const { rev, cos, sin } = fftTables
  for (let i = 0; i < NFFT; i++) {
    const j = rev[i]
    if (j > i) {
      let t = re[i]
      re[i] = re[j]
      re[j] = t
      t = im[i]
      im[i] = im[j]
      im[j] = t
    }
  }
  const sign = inverse ? 1 : -1
  for (let size = 2; size <= NFFT; size <<= 1) {
    const half = size >> 1
    const step = NFFT / size
    for (let start = 0; start < NFFT; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step]
        const wi = sign * sin[k * step]
        const a = start + k
        const b = a + half
        const tr = re[b] * wr - im[b] * wi
        const ti = re[b] * wi + im[b] * wr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
      }
    }
  }
}

/** Reflect padding (torch 'reflect': the edge sample is not repeated). */
function reflectPad(x: Float32Array, left: number, right: number): Float64Array {
  const n = x.length
  const out = new Float64Array(n + left + right)
  for (let i = 0; i < out.length; i++) {
    let j = i - left
    while (j < 0 || j >= n) j = j < 0 ? -j : 2 * (n - 1) - j
    out[i] = x[j]
  }
  return out
}

/**
 * HTDemucs._spec for one channel of one segment: [re, im] each BINS × FRAMES (frequency-major).
 * Pads by 1.5 hops (reflect), torch.stft(center=True, reflect, Hann, normalized), drops Nyquist and
 * the 2 frames at each end.
 */
function spec(x: Float32Array): { re: Float32Array; im: Float32Array } {
  const pad = (HOP / 2) * 3
  const padded = reflectPad(x, pad, pad + FRAMES * HOP - x.length)
  const centred = reflectPad(new Float32Array(padded), NFFT / 2, NFFT / 2)
  const totalFrames = 1 + Math.floor((centred.length - NFFT) / HOP) // FRAMES + 4
  const outRe = new Float32Array(BINS * FRAMES)
  const outIm = new Float32Array(BINS * FRAMES)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const { win } = fftTables
  const norm = 1 / Math.sqrt(NFFT)
  for (let f = 2; f < 2 + FRAMES && f < totalFrames; f++) {
    const at = f * HOP
    for (let i = 0; i < NFFT; i++) {
      re[i] = centred[at + i] * win[i]
      im[i] = 0
    }
    fft(re, im, false)
    const col = f - 2
    for (let k = 0; k < BINS; k++) {
      outRe[k * FRAMES + col] = re[k] * norm
      outIm[k * FRAMES + col] = im[k] * norm
    }
  }
  return { re: outRe, im: outIm }
}

/** HTDemucs._ispec for one channel: spectrogram (BINS × FRAMES, re/im) back to SEGMENT samples. */
function ispec(sr: Float32Array, si: Float32Array, srOffset: number, siOffset: number, out: Float32Array, outOffset: number): void {
  const frames = FRAMES + 4 // 2 empty frames padded at each end
  const pad = (HOP / 2) * 3
  const le = HOP * Math.ceil(SEGMENT / HOP) + 2 * pad
  const total = NFFT + HOP * (frames - 1) // OLA length before removing the centre padding
  const y = new Float64Array(total)
  const env = new Float64Array(total)
  const re = new Float64Array(NFFT)
  const im = new Float64Array(NFFT)
  const { win } = fftTables
  // normalized=True: frames scaled by sqrt(N); irfft scales by 1/N.
  const scale = Math.sqrt(NFFT) / NFFT
  for (let f = 0; f < frames; f++) {
    const col = f - 2
    re.fill(0)
    im.fill(0)
    if (col >= 0 && col < FRAMES) {
      for (let k = 0; k < BINS; k++) {
        re[k] = sr[srOffset + k * FRAMES + col]
        im[k] = si[siOffset + k * FRAMES + col]
      }
      // Hermitian symmetry (bin BINS, Nyquist, stays 0).
      for (let k = 1; k < BINS; k++) {
        re[NFFT - k] = re[k]
        im[NFFT - k] = -im[k]
      }
    }
    fft(re, im, true)
    const at = f * HOP
    for (let i = 0; i < NFFT; i++) {
      y[at + i] += re[i] * scale * win[i]
      env[at + i] += win[i] * win[i]
    }
  }
  // Remove the STFT centre padding, then HTDemucs' own 1.5-hop padding.
  const start = NFFT / 2 + pad
  for (let i = 0; i < SEGMENT; i++) {
    const j = start + i
    const e = env[j]
    out[outOffset + i] += e > 1e-11 ? y[j] / e : 0
  }
  void le
}

/** One model pass over a segment (2 × SEGMENT samples): S sources × 2 channels × SEGMENT. */
async function segmentPass(left: Float32Array, right: Float32Array, run: RunModel): Promise<Float32Array> {
  const mix = new Float32Array(2 * SEGMENT)
  mix.set(left, 0)
  mix.set(right, SEGMENT)
  const sl = spec(left)
  const sr = spec(right)
  const plane = BINS * FRAMES
  const mag = new Float32Array(4 * plane)
  mag.set(sl.re, 0)
  mag.set(sl.im, plane)
  mag.set(sr.re, 2 * plane)
  mag.set(sr.im, 3 * plane)
  const { spec: z, wave } = await run(mix, mag)
  // z: [1, S sources, 4 (L re, L im, R re, R im), BINS, FRAMES]; wave: [1, S, 2, SEGMENT].
  const out = new Float32Array(wave)
  for (let s = 0; s < S; s++) {
    for (let c = 0; c < 2; c++) {
      const base = (s * 4 + c * 2) * plane
      ispec(z, z, base, base + plane, out, (s * 2 + c) * SEGMENT)
    }
  }
  return out
}

/**
 * Separates a stereo track at 44.1 kHz. Returns, per source, interleaved stereo float32.
 * `progress` gets 0..1 after each segment.
 */
export async function separate(
  left: Float32Array,
  right: Float32Array,
  run: RunModel,
  progress: (p: number) => void = () => {},
): Promise<Record<Source, Float32Array>> {
  const length = left.length
  // Normalise like Demucs' command line (on the mono reference), undone at the end.
  let sum = 0
  for (let i = 0; i < length; i++) sum += (left[i] + right[i]) / 2
  const mean = sum / length
  let sq = 0
  for (let i = 0; i < length; i++) {
    const d = (left[i] + right[i]) / 2 - mean
    sq += d * d
  }
  const std = Math.sqrt(sq / Math.max(1, length - 1)) + 1e-8
  const l = new Float32Array(length)
  const r = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    l[i] = (left[i] - mean) / std
    r[i] = (right[i] - mean) / std
  }

  // Triangular weights across a segment, so overlapping segments cross-fade.
  const weight = new Float32Array(SEGMENT)
  const half = Math.floor(SEGMENT / 2)
  for (let i = 0; i < half; i++) weight[i] = i + 1
  for (let i = half; i < SEGMENT; i++) weight[i] = SEGMENT - i
  let wmax = 0
  for (const w of weight) wmax = Math.max(wmax, w)
  for (let i = 0; i < SEGMENT; i++) weight[i] /= wmax

  const out = Array.from({ length: S * 2 }, () => new Float32Array(length)) // source × channel
  const sumWeight = new Float32Array(length)
  const stride = Math.floor((1 - OVERLAP) * SEGMENT)
  const offsets: number[] = []
  for (let o = 0; o < length; o += stride) offsets.push(o)

  for (let n = 0; n < offsets.length; n++) {
    const offset = offsets[n]
    const chunkLength = Math.min(SEGMENT, length - offset)
    // TensorChunk.padded: centred zero padding up to the segment length.
    const delta = SEGMENT - chunkLength
    const start = offset - Math.floor(delta / 2)
    const segL = new Float32Array(SEGMENT)
    const segR = new Float32Array(SEGMENT)
    for (let i = 0; i < SEGMENT; i++) {
      const j = start + i
      if (j >= 0 && j < length) {
        segL[i] = l[j]
        segR[i] = r[j]
      }
    }
    const res = await segmentPass(segL, segR, run)
    // center_trim back to the chunk, weighted into place.
    const trim = Math.floor(delta / 2)
    for (let sc = 0; sc < S * 2; sc++) {
      const src = sc * SEGMENT + trim
      const dst = out[sc]
      for (let i = 0; i < chunkLength; i++) dst[offset + i] += weight[i] * res[src + i]
    }
    for (let i = 0; i < chunkLength; i++) sumWeight[offset + i] += weight[i]
    progress((n + 1) / offsets.length)
  }

  const result = {} as Record<Source, Float32Array>
  SOURCES.forEach((name, s) => {
    const a = out[s * 2]
    const b = out[s * 2 + 1]
    const inter = new Float32Array(length * 2)
    for (let i = 0; i < length; i++) {
      const w = sumWeight[i] || 1
      inter[2 * i] = (a[i] / w) * std + mean
      inter[2 * i + 1] = (b[i] / w) * std + mean
    }
    result[name] = inter
  })
  return result
}
