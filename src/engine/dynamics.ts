import { clamp } from '../store'

/** Compressor and limiter settings of the master bus. Times in seconds, levels in dB. */
export interface Dynamics {
  comp: boolean
  threshold: number // -40..0
  ratio: number // 1..20
  attack: number // 0.001..0.1
  release: number // 0.03..1
  makeup: number // 0..18, used when autoGain is off
  autoGain: boolean // make-up gain set by ear-matching: the compressed mix as loud as it came in
  preset: string | null // name of the preset the settings came from, null once changed by hand
  lim: boolean
  ceiling: number // -6..0, the loudest the master may ever get
  limRelease: number // 0.01..0.5
}

export const DYNAMICS_DEFAULT: Dynamics = {
  comp: false,
  threshold: -18,
  ratio: 2,
  attack: 0.03,
  release: 0.25,
  makeup: 2,
  autoGain: true,
  preset: 'Soft',
  lim: true, // safety on by default: only the peaks above -1 dB are touched
  ceiling: -1,
  limRelease: 0.08,
}

/** Starting points for the compressor, from barely there to radio-loud. */
export const COMP_PRESETS: { name: string; hint: string; set: Pick<Dynamics, 'threshold' | 'ratio' | 'attack' | 'release' | 'makeup'> }[] =
  [
    {
      name: 'Soft',
      hint: 'Only smooths the peaks, barely noticeable',
      set: { threshold: -18, ratio: 2, attack: 0.03, release: 0.25, makeup: 2 },
    },
    { name: 'Glue', hint: 'Glues both decks into one sound', set: { threshold: -20, ratio: 3, attack: 0.01, release: 0.15, makeup: 3 } },
    {
      name: 'Sound system',
      hint: 'Tight bass and steady level for the dance',
      set: { threshold: -24, ratio: 4, attack: 0.005, release: 0.12, makeup: 5 },
    },
    { name: 'Radio', hint: 'Loud and squeezed, like on the radio', set: { threshold: -28, ratio: 6, attack: 0.003, release: 0.08, makeup: 7 } },
  ]

export const LIMITS = {
  threshold: [-40, 0],
  ratio: [1, 20],
  attack: [0.001, 0.1],
  release: [0.03, 1],
  makeup: [0, 18],
  ceiling: [-6, 0],
  limRelease: [0.01, 0.5],
} as const

export function cleanDynamics(d: Partial<Dynamics> | undefined): Dynamics {
  const out = { ...DYNAMICS_DEFAULT, ...(d ?? {}) }
  for (const [key, [lo, hi]] of Object.entries(LIMITS)) {
    const k = key as keyof typeof LIMITS
    out[k] = Number.isFinite(out[k]) ? clamp(out[k], lo, hi) : DYNAMICS_DEFAULT[k]
  }
  out.comp = !!out.comp
  out.autoGain = out.autoGain !== false
  // Preset names from before the interface went English.
  out.preset = ({ Suave: 'Soft', Cola: 'Glue', Rádio: 'Radio' } as Record<string, string>)[out.preset ?? ''] ?? out.preset
  out.lim = !!out.lim
  return out
}

const db = (v: number) => Math.pow(10, v / 20)

/**
 * Master dynamics: input ─► compressor ─► make-up gain ─► limiter ─► safety clip ─► output.
 * Each stage is skipped (wired around) while it is off. The limiter is a fast, hard compressor
 * just under the ceiling, and a soft clipper catches whatever its attack lets through.
 */
export class MasterDynamics {
  readonly input: GainNode
  readonly output: GainNode
  private comp: DynamicsCompressorNode
  private makeup: GainNode
  private lim: DynamicsCompressorNode
  private clipIn: GainNode
  private clip: WaveShaperNode
  private wired: string = ''
  // Auto make-up: the level going into the compressor and coming out of it (before make-up), as
  // slowly averaged power, so the make-up gain is just what brings the compressed mix back level.
  private inTap: AnalyserNode
  private outTap: AnalyserNode
  private buf = new Float32Array(2048)
  private inPow = 0
  private outPow = 0
  private timer = 0
  private auto = false
  private last: Dynamics | null = null
  /** The make-up gain auto mode is using right now, in dB. */
  autoMakeup = 0

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.comp = ctx.createDynamicsCompressor()
    this.makeup = ctx.createGain()
    this.lim = ctx.createDynamicsCompressor()
    this.lim.ratio.value = 20
    this.lim.knee.value = 0
    this.lim.attack.value = 0.001
    this.clipIn = ctx.createGain()
    this.clipIn.gain.value = 0.5 // the curve below covers -2..2
    this.clip = ctx.createWaveShaper()
    this.clip.oversample = '4x'
    this.comp.connect(this.makeup)
    this.inTap = ctx.createAnalyser()
    this.outTap = ctx.createAnalyser()
    this.inTap.fftSize = this.outTap.fftSize = 2048
    this.input.connect(this.inTap)
    this.comp.connect(this.outTap)
    this.lim.connect(this.clipIn)
    this.clipIn.connect(this.clip)
  }

  /** Compressor gain reduction right now, in dB (0 or negative). */
  get compReduction(): number {
    return this.wired.includes('c') ? this.comp.reduction : 0
  }

  get limReduction(): number {
    return this.wired.includes('l') ? this.lim.reduction : 0
  }

  private power(tap: AnalyserNode): number {
    tap.getFloatTimeDomainData(this.buf)
    let sum = 0
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
    return sum / this.buf.length
  }

  /** Ten times a second while the compressor runs in auto: follow the loudness and set the make-up. */
  private follow(): void {
    const inP = this.power(this.inTap)
    const outP = this.power(this.outTap)
    if (inP < 1e-6) return // silence (under -60 dB): keep what we had
    const k = 1 - Math.exp(-0.1 / 1.5) // ~1.5 s average: steady, but catches up within a phrase
    this.inPow = this.inPow ? this.inPow + (inP - this.inPow) * k : inP
    this.outPow = this.outPow ? this.outPow + (outP - this.outPow) * k : outP
    this.setAuto(10 * Math.log10(this.inPow / Math.max(1e-9, this.outPow)))
  }

  private setAuto(gain: number): void {
    const [lo, hi] = LIMITS.makeup
    this.autoMakeup = Math.max(lo, Math.min(hi, Number.isFinite(gain) ? gain : 0))
    this.makeup.gain.setTargetAtTime(db(this.autoMakeup), this.ctx.currentTime, 0.25)
  }

  /**
   * A new threshold or ratio (a preset, say) changes how much gets squeezed at once; waiting for the
   * average would let the level jump for a second. Estimate the new squeeze from how loud the mix is
   * (its peaks sit roughly 8 dB over its average) and start the make-up there.
   */
  private predict(d: Dynamics): void {
    if (!this.inPow) return
    const peak = 10 * Math.log10(this.inPow) + 8
    const squeeze = Math.max(0, peak - d.threshold) * (1 - 1 / d.ratio) * 0.6
    this.outPow = this.inPow / Math.pow(10, squeeze / 10)
    this.setAuto(squeeze)
  }

  apply(d: Dynamics): void {
    const now = this.ctx.currentTime
    const to = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.02)
    const auto = d.comp && d.autoGain
    const reshaped = !this.last || this.last.threshold !== d.threshold || this.last.ratio !== d.ratio || !this.last.comp
    this.last = d
    if (auto && !this.auto) this.timer = window.setInterval(() => this.follow(), 100)
    if (!auto && this.auto) window.clearInterval(this.timer)
    this.auto = auto
    to(this.comp.threshold, d.threshold)
    to(this.comp.ratio, d.ratio)
    to(this.comp.knee, 6)
    to(this.comp.attack, d.attack)
    to(this.comp.release, d.release)
    if (!auto) to(this.makeup.gain, db(d.makeup))
    else if (reshaped) this.predict(d)
    to(this.lim.threshold, d.ceiling - 0.5)
    to(this.lim.release, d.limRelease)
    this.clip.curve = softClip(db(d.ceiling))
    this.rewire((d.comp ? 'c' : '') + (d.lim ? 'l' : ''))
  }

  private rewire(stages: string): void {
    if (stages === this.wired) return
    this.wired = stages
    this.input.disconnect()
    this.makeup.disconnect()
    this.clip.disconnect()
    const compOut: AudioNode = stages.includes('c') ? this.makeup : this.input
    if (stages.includes('c')) this.input.connect(this.comp)
    if (stages.includes('l')) {
      compOut.connect(this.lim)
      this.clip.connect(this.output)
    } else compOut.connect(this.output)
  }
}

/** Straight up to 85% of the ceiling, then bends smoothly so nothing passes the ceiling. Input spans -2..2. */
function softClip(ceiling: number): Float32Array<ArrayBuffer> {
  const n = 4096
  const curve = new Float32Array(n)
  const knee = ceiling * 0.85
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2
    const a = Math.abs(x)
    const y = a <= knee ? a : knee + (ceiling - knee) * Math.tanh((a - knee) / (ceiling - knee))
    curve[i] = Math.sign(x) * y
  }
  return curve
}
