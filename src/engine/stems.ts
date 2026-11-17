/**
 * Real-time "stems" for local files, done with signal processing (no AI model):
 *   kick  = low band (<180 Hz) during transients
 *   bass  = low band between transients
 *   vocal = centre (mid) of the 180 Hz–6.5 kHz band
 *   instr = sides of that band (whatever is panned away from the centre)
 *   hat   = everything above 6.5 kHz
 * The crossovers are Linkwitz-Riley, so with every stem on the level is flat across the spectrum.
 */
export const STEMS = ['vocal', 'instr', 'bass', 'kick', 'hat'] as const
export type Stem = (typeof STEMS)[number]
export type StemState = Record<Stem, boolean>
export const ALL_STEMS: StemState = { vocal: true, instr: true, bass: true, kick: true, hat: true }

const WORKLET = `
function biquad(type, freq) {
  const w = 2 * Math.PI * freq / sampleRate, c = Math.cos(w), alpha = Math.sin(w) / Math.SQRT2
  const a0 = 1 + alpha
  const b1 = type === 'lp' ? 1 - c : -(1 + c)
  const b0 = Math.abs(b1) / 2
  return { b0: b0 / a0, b1: b1 / a0, b2: b0 / a0, a1: -2 * c / a0, a2: (1 - alpha) / a0, x1: 0, x2: 0, y1: 0, y2: 0 }
}
function run(f, x) {
  const y = f.b0 * x + f.b1 * f.x1 + f.b2 * f.x2 - f.a1 * f.y1 - f.a2 * f.y2
  f.x2 = f.x1; f.x1 = x; f.y2 = f.y1; f.y1 = y
  return y
}
const coef = (ms) => 1 - Math.exp(-1 / (sampleRate * ms / 1000))

class VxStems extends AudioWorkletProcessor {
  constructor() {
    super()
    // Linkwitz-Riley crossovers (two cascaded Butterworth sections each), per channel:
    // [low-pass 180, high-pass 180, low-pass 6500, high-pass 6500] x 2 sections.
    const band = (type, f) => [biquad(type, f), biquad(type, f)]
    this.ch = [0, 1].map(() => ({ lo: band('lp', 180), rest: band('hp', 180), mid: band('lp', 6500), hi: band('hp', 6500) }))
    this.target = [1, 1, 1, 1, 1] // vocal, instr, bass, kick, hat
    this.gain = [1, 1, 1, 1, 1]
    this.fast = 0; this.slow = 0; this.gate = 0
    this.kFast = coef(5); this.kSlow = coef(400)
    this.kOpen = coef(1.5); this.kClose = coef(120); this.kGain = coef(8)
    this.port.onmessage = (e) => { this.target = e.data }
  }
  split(c, x) {
    const low = run(c.lo[1], run(c.lo[0], x))
    const rest = run(c.rest[1], run(c.rest[0], x))
    return [low, run(c.mid[1], run(c.mid[0], rest)), run(c.hi[1], run(c.hi[0], rest))]
  }
  process(inputs, outputs) {
    const input = inputs[0], out = outputs[0]
    if (!input || !input[0]) return true
    const inL = input[0], inR = input[1] || inL
    const outL = out[0], outR = out[1] || out[0]
    const g = this.gain, t = this.target
    for (let i = 0; i < inL.length; i++) {
      for (let s = 0; s < 5; s++) g[s] += (t[s] - g[s]) * this.kGain
      const [lowL, midL, highL] = this.split(this.ch[0], inL[i])
      const [lowR, midR, highR] = this.split(this.ch[1], inR[i])

      // Kick detector: low-band power jumping well above its recent average.
      const mono = (lowL + lowR) * 0.5
      this.fast += (mono * mono - this.fast) * this.kFast
      this.slow += (this.fast - this.slow) * this.kSlow
      const want = Math.min(1, Math.max(0, (this.fast / (this.slow + 1e-7) - 1.6) / 1.4))
      this.gate += (want - this.gate) * (want > this.gate ? this.kOpen : this.kClose)
      const lowGain = g[3] * this.gate + g[2] * (1 - this.gate)

      const centre = (midL + midR) * 0.5 * g[0]
      const side = (midL - midR) * 0.5 * g[1]
      outL[i] = lowL * lowGain + centre + side + highL * g[4]
      if (outR !== outL) outR[i] = lowR * lowGain + centre - side + highR * g[4]
    }
    return true
  }
}
registerProcessor('vx-stems', VxStems)
`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

/** Creates the stem splitter node; send it gains with setStems(). */
export async function createStems(ctx: BaseAudioContext): Promise<AudioWorkletNode> {
  let ready = loaded.get(ctx)
  if (!ready) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    loaded.set(ctx, ready)
  }
  await ready
  return new AudioWorkletNode(ctx, 'vx-stems', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  })
}

export function setStems(node: AudioWorkletNode, stems: StemState): void {
  node.port.postMessage(STEMS.map((s) => (stems[s] ? 1 : 0)))
}
