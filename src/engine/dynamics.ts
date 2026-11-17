import { clamp } from '../store'

/** Compressor and limiter settings of the master bus. Times in seconds, levels in dB. */
export interface Dynamics {
  comp: boolean
  threshold: number // -40..0
  ratio: number // 1..20
  attack: number // 0.001..0.1
  release: number // 0.03..1
  makeup: number // 0..18
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
  preset: 'Suave',
  lim: true, // safety on by default: only the peaks above -1 dB are touched
  ceiling: -1,
  limRelease: 0.08,
}

/** Starting points for the compressor, from barely there to radio-loud. */
export const COMP_PRESETS: { name: string; hint: string; set: Pick<Dynamics, 'threshold' | 'ratio' | 'attack' | 'release' | 'makeup'> }[] =
  [
    {
      name: 'Suave',
      hint: 'Só alisa os picos, quase não se nota',
      set: { threshold: -18, ratio: 2, attack: 0.03, release: 0.25, makeup: 2 },
    },
    { name: 'Cola', hint: 'Junta os dois decks num som só', set: { threshold: -20, ratio: 3, attack: 0.01, release: 0.15, makeup: 3 } },
    {
      name: 'Sound system',
      hint: 'Graves firmes e volume constante para a pista',
      set: { threshold: -24, ratio: 4, attack: 0.005, release: 0.12, makeup: 5 },
    },
    { name: 'Rádio', hint: 'Alto e apertado, como numa rádio', set: { threshold: -28, ratio: 6, attack: 0.003, release: 0.08, makeup: 7 } },
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

  apply(d: Dynamics): void {
    const now = this.ctx.currentTime
    const to = (p: AudioParam, v: number) => p.setTargetAtTime(v, now, 0.02)
    to(this.comp.threshold, d.threshold)
    to(this.comp.ratio, d.ratio)
    to(this.comp.knee, 6)
    to(this.comp.attack, d.attack)
    to(this.comp.release, d.release)
    to(this.makeup.gain, db(d.makeup))
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
