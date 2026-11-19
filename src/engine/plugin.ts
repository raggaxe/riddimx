import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { decks } from './deck'
import { STEMS, type Stem } from './stems'
import { liveDeck } from './outboard'

/**
 * Plugin tab: two AUX buses. Each stem of each deck (vocal, instruments, bass, kick, hats) can be sent
 * into either one, after the deck's fader; each AUX runs one effect and returns into the master.
 * So a reverb can sit on the vocal only, or a flanger on the hats only, while the rest stays dry.
 */
export type AuxFx = 'reverb' | 'flanger' | 'delay' | 'phaser'

export const AUX_FX: { id: AuxFx; label: string; a: string; b: string; hint: string }[] = [
  { id: 'reverb', label: 'Reverb', a: 'SIZE', b: 'TONE', hint: 'A room around the sound: size of the space, how bright it is' },
  { id: 'flanger', label: 'Flanger', a: 'RATE', b: 'DEPTH', hint: 'The jet sweep: how fast and how deep' },
  { id: 'delay', label: 'Delay', a: 'TIME', b: 'FDBK', hint: 'Echo on the beat (1/8 to 1 bar) and how long it repeats' },
  { id: 'phaser', label: 'Phaser', a: 'RATE', b: 'DEPTH', hint: 'A swirling notch sweep: how fast and how deep' },
]

export interface AuxState {
  fx: AuxFx
  a: number // 0..1, the effect's first knob
  b: number // 0..1, its second knob
  ret: number // 0..1, return level into the master
}

export interface PluginState {
  aux: AuxState[]
  /** send[aux][deck][stem], 0..1 */
  send: Record<'A' | 'B', Record<Stem, number>>[]
}

const LS = 'vx_plugin'
const zero = (): Record<Stem, number> => Object.fromEntries(STEMS.map((s) => [s, 0])) as Record<Stem, number>

function saved(): Partial<PluginState> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

const DEFAULT_AUX: AuxState[] = [
  { fx: 'reverb', a: 0.5, b: 0.5, ret: 0.7 },
  { fx: 'flanger', a: 0.3, b: 0.6, ret: 0.7 },
]

/** One AUX: in ─► effect ─► return ─► master. The effect is rebuilt when its type changes. */
class Aux {
  readonly input: GainNode
  readonly ret: GainNode
  private nodes: AudioNode[] = []
  private lfo: OscillatorNode | null = null
  private set: (s: AuxState) => void = () => undefined
  private built: AuxFx | null = null

  constructor(private ctx: AudioContext) {
    this.input = ctx.createGain()
    this.ret = ctx.createGain()
    this.ret.connect(mixer.masterGain)
  }

  apply(s: AuxState): void {
    if (s.fx !== this.built) this.build(s.fx)
    this.set(s)
    this.ret.gain.setTargetAtTime(s.ret, this.ctx.currentTime, 0.02)
  }

  private build(fx: AuxFx): void {
    const ctx = this.ctx
    this.input.disconnect()
    for (const n of this.nodes) n.disconnect()
    this.lfo?.stop()
    this.lfo = null
    this.nodes = []
    this.built = fx
    const to = (p: AudioParam, v: number) => p.setTargetAtTime(v, ctx.currentTime, 0.03)
    if (fx === 'reverb') {
      const conv = ctx.createConvolver()
      const tone = ctx.createBiquadFilter()
      tone.type = 'lowpass'
      this.input.connect(conv).connect(tone).connect(this.ret)
      this.nodes = [conv, tone]
      let size = -1
      this.set = (s) => {
        const want = Math.round((0.6 + s.a * 4.4) * 10) / 10 // 0.6..5 s tail
        if (want !== size) {
          size = want
          conv.buffer = impulse(ctx, want)
        }
        to(tone.frequency, 1500 * Math.pow(12000 / 1500, s.b))
      }
    } else if (fx === 'flanger' || fx === 'phaser') {
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      lfo.connect(depth)
      lfo.start()
      this.lfo = lfo
      if (fx === 'flanger') {
        const delay = ctx.createDelay(0.03)
        delay.delayTime.value = 0.004
        const fb = ctx.createGain()
        fb.gain.value = 0.5
        depth.connect(delay.delayTime)
        this.input.connect(delay).connect(this.ret)
        delay.connect(fb).connect(delay)
        this.input.connect(this.ret) // dry + delayed: the comb that sweeps
        this.nodes = [delay, fb, depth]
        this.set = (s) => {
          to(lfo.frequency, 0.05 * Math.pow(4 / 0.05, s.a))
          to(depth.gain, 0.0005 + s.b * 0.0035)
        }
      } else {
        const stages = [0, 1, 2, 3, 4, 5].map(() => {
          const f = ctx.createBiquadFilter()
          f.type = 'allpass'
          f.frequency.value = 800
          f.Q.value = 0.7
          depth.connect(f.frequency)
          return f
        })
        let node: AudioNode = this.input
        for (const f of stages) node = node.connect(f)
        node.connect(this.ret)
        this.input.connect(this.ret)
        this.nodes = [...stages, depth]
        this.set = (s) => {
          to(lfo.frequency, 0.05 * Math.pow(3 / 0.05, s.a))
          to(depth.gain, 100 + s.b * 700)
        }
      }
    } else {
      const delay = ctx.createDelay(4)
      const fb = ctx.createGain()
      const dark = ctx.createBiquadFilter()
      dark.type = 'lowpass'
      dark.frequency.value = 4000
      this.input.connect(delay).connect(this.ret)
      delay.connect(dark).connect(fb).connect(delay)
      this.nodes = [delay, fb, dark]
      this.set = (s) => {
        // TIME: 1/8, 1/4, 3/8, 1/2, 3/4, 1 bar of the music on air (half a second a beat when unknown).
        const beats = [0.5, 1, 1.5, 2, 3, 4][Math.min(5, Math.floor(s.a * 6))]
        const live = liveDeck()?.get()
        const beat = live?.bpm ? 60 / (live.bpm * (live.rate || 1)) : 0.5
        to(delay.delayTime, Math.min(3.9, beat * beats))
        to(fb.gain, s.b * 0.85)
      }
    }
  }
}

/** A plate-like tail: decaying noise, a little darker as it fades. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let low = 0
    for (let i = 0; i < n; i++) {
      const t = i / n
      low += (Math.random() * 2 - 1 - low) * (0.6 - 0.45 * t)
      d[i] = low * Math.pow(1 - t, 2.2)
    }
  }
  return buf
}

class Plugin extends Store<PluginState> {
  private units: Aux[]

  constructor() {
    const s = saved()
    const aux = DEFAULT_AUX.map((d, i) => {
      const x = s.aux?.[i]
      return {
        fx: AUX_FX.some((f) => f.id === x?.fx) ? (x!.fx as AuxFx) : d.fx,
        a: clamp(x?.a ?? d.a, 0, 1),
        b: clamp(x?.b ?? d.b, 0, 1),
        ret: clamp(x?.ret ?? d.ret, 0, 1),
      }
    })
    const send = [0, 1].map((i) => ({
      A: { ...zero(), ...(s.send?.[i]?.A ?? {}) },
      B: { ...zero(), ...(s.send?.[i]?.B ?? {}) },
    }))
    super({ aux, send })
    this.units = aux.map(() => new Aux(mixer.ctx))
    decks.forEach((d) => d.auxPost.forEach((post, i) => post.connect(this.units[i].input)))
    this.units.forEach((u, i) => u.apply(aux[i]))
    this.pushSends()
    // A synced delay follows the tempo of what is on air.
    window.setInterval(() => this.state.aux.forEach((a, i) => a.fx === 'delay' && this.units[i].apply(a)), 2000)
  }

  private persist(): void {
    try {
      localStorage.setItem(LS, JSON.stringify(this.state))
    } catch {
      /* not remembered */
    }
  }

  updateAux(i: number, change: Partial<AuxState>): void {
    const aux = this.state.aux.map((a, k) => (k === i ? { ...a, ...change } : a))
    this.set({ aux })
    this.units[i].apply(aux[i])
    this.persist()
  }

  setSend(i: number, deck: 'A' | 'B', stem: Stem, v: number): void {
    const send = this.state.send.map((x, k) => (k === i ? { ...x, [deck]: { ...x[deck], [stem]: clamp(v, 0, 1) } } : x))
    this.set({ send })
    this.pushSends()
    this.persist()
  }

  /** Every send of one AUX back to zero. */
  clearSends(i: number): void {
    const send = this.state.send.map((x, k) => (k === i ? { A: zero(), B: zero() } : x))
    this.set({ send })
    this.pushSends()
    this.persist()
  }

  private pushSends(): void {
    const now = mixer.ctx.currentTime
    this.state.send.forEach((x, i) =>
      decks.forEach((d) => {
        const name = d.name as 'A' | 'B'
        for (const stem of STEMS) d.auxSend[i][stem].gain.setTargetAtTime(x[name][stem], now, 0.02)
      }),
    )
  }
}

export const plugin = new Plugin()
