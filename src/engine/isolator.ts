import { Store, clamp } from '../store'
import { mixer } from './mixer'

/**
 * Isolator and filter on the whole master, the heart of a dub desk:
 *  · three bands (bass / mid / top) split at two adjustable frequencies, each with its own level
 *    and a KILL that cuts it at once — take the bass off the whole dance and drop it back on the one;
 *  · a high-pass and a low-pass together (sweep the mix thin or dark), switched on with ON.
 * While nothing is touched the sound goes straight through, so the split never colours it.
 */

export interface IsolatorState {
  low: number // 0..1.5 level of the bass band (1 = as is)
  mid: number
  top: number
  killLow: boolean
  killMid: boolean
  killTop: boolean
  lowHz: number // 60..400, bass / mid split
  highHz: number // 1500..8000, mid / top split
  filterOn: boolean
  hp: number // 0..1 → 20 Hz .. 2 kHz
  lp: number // 0..1 → 20 kHz .. 250 Hz
}

const LS = 'vx_isolator'
const DEFAULT: IsolatorState = {
  low: 1,
  mid: 1,
  top: 1,
  killLow: false,
  killMid: false,
  killTop: false,
  lowHz: 200,
  highHz: 3000,
  filterOn: false,
  hp: 0,
  lp: 0,
}

export const hpHz = (v: number) => 20 * Math.pow(100, v) // 20 Hz … 2 kHz
export const lpHz = (v: number) => 20000 * Math.pow(250 / 20000, v) // 20 kHz … 250 Hz

class Isolator extends Store<IsolatorState> {
  readonly input: GainNode
  readonly output: GainNode
  private dry: GainNode
  private wet: GainNode
  private bands: GainNode[] = []
  private splits: { lowLP: BiquadFilterNode[]; midHP: BiquadFilterNode[]; midLP: BiquadFilterNode[]; topHP: BiquadFilterNode[] }
  private hp: BiquadFilterNode
  private lp: BiquadFilterNode
  // Extra steep edges used only by the kills, so a killed band is really gone (not just 15 dB down).
  private killHP: BiquadFilterNode[] = []
  private killLP: BiquadFilterNode[] = []

  constructor() {
    let saved: Partial<IsolatorState> = {}
    try {
      saved = JSON.parse(localStorage.getItem(LS) || '{}')
    } catch {
      /* defaults */
    }
    // Kills always start off: nobody wants to open the app with the bass gone.
    // The master filter is gone from the screen (filtering is per channel): it always stays off.
    super({ ...DEFAULT, ...saved, killLow: false, killMid: false, killTop: false, filterOn: false, hp: 0, lp: 0 })
    const ctx = mixer.ctx
    this.input = ctx.createGain()
    this.output = ctx.createGain()
    this.dry = ctx.createGain()
    this.wet = ctx.createGain()
    const f = (type: BiquadFilterType) => {
      const n = ctx.createBiquadFilter()
      n.type = type
      n.Q.value = Math.SQRT1_2
      return n
    }
    // Two 2nd-order filters in a row per edge (Linkwitz-Riley 24 dB): the bands add back up flat.
    this.splits = {
      lowLP: [f('lowpass'), f('lowpass')],
      midHP: [f('highpass'), f('highpass')],
      midLP: [f('lowpass'), f('lowpass')],
      topHP: [f('highpass'), f('highpass')],
    }
    this.hp = f('highpass')
    this.lp = f('lowpass')
    this.bands = [ctx.createGain(), ctx.createGain(), ctx.createGain()]
    const { lowLP, midHP, midLP, topHP } = this.splits
    this.input.connect(this.dry).connect(this.output)
    this.killHP = [f('highpass'), f('highpass'), f('highpass')]
    this.killLP = [f('lowpass'), f('lowpass'), f('lowpass')]
    let node: AudioNode = this.input
    for (const n of [this.hp, this.lp, ...this.killHP, ...this.killLP]) {
      node.connect(n)
      node = n
    }
    this.lp.disconnect()
    this.lp.connect(this.killHP[0])
    const pre = this.killLP[this.killLP.length - 1]
    pre.connect(lowLP[0]).connect(lowLP[1]).connect(this.bands[0])
    pre.connect(midHP[0]).connect(midHP[1]).connect(midLP[0]).connect(midLP[1]).connect(this.bands[1])
    pre.connect(topHP[0]).connect(topHP[1]).connect(this.bands[2])
    for (const b of this.bands) b.connect(this.wet)
    this.wet.connect(this.output)
    this.apply()
  }

  /** In use: any band moved or killed, or the filter on. */
  get active(): boolean {
    const s = this.state
    return s.killLow || s.killMid || s.killTop || s.filterOn || [s.low, s.mid, s.top].some((v) => Math.abs(v - 1) > 0.02)
  }

  private apply(): void {
    const s = this.state
    const now = mixer.ctx.currentTime
    const to = (p: AudioParam, v: number, tc = 0.02) => p.setTargetAtTime(v, now, tc)
    for (const n of this.splits.lowLP) to(n.frequency, s.lowHz)
    for (const n of this.splits.midHP) to(n.frequency, s.lowHz)
    for (const n of this.splits.midLP) to(n.frequency, s.highHz)
    for (const n of this.splits.topHP) to(n.frequency, s.highHz)
    // Kills are instant (5 ms), like a switch; levels glide.
    to(this.bands[0].gain, s.killLow ? 0 : s.low, s.killLow ? 0.005 : 0.02)
    to(this.bands[1].gain, s.killMid ? 0 : s.mid, s.killMid ? 0.005 : 0.02)
    to(this.bands[2].gain, s.killTop ? 0 : s.top, s.killTop ? 0.005 : 0.02)
    // Killed bass: a 36 dB/octave edge just above the split; killed top: the same just below it.
    for (const n of this.killHP) to(n.frequency, s.killLow ? s.lowHz * 1.3 : 10, 0.005)
    for (const n of this.killLP) to(n.frequency, s.killTop ? s.highHz * 0.75 : 22000, 0.005)
    to(this.hp.frequency, s.filterOn ? hpHz(s.hp) : 10)
    to(this.lp.frequency, s.filterOn ? lpHz(s.lp) : 22000)
    // Untouched: straight through.
    const on = this.active
    to(this.wet.gain, on ? 1 : 0, 0.01)
    to(this.dry.gain, on ? 0 : 1, 0.01)
  }

  update(change: Partial<IsolatorState>): void {
    const next = { ...this.state, ...change }
    next.low = clamp(next.low, 0, 1.5)
    next.mid = clamp(next.mid, 0, 1.5)
    next.top = clamp(next.top, 0, 1.5)
    next.lowHz = clamp(next.lowHz, 60, 400)
    next.highHz = clamp(next.highHz, 1500, 8000)
    next.hp = clamp(next.hp, 0, 1)
    next.lp = clamp(next.lp, 0, 1)
    this.set(next)
    this.apply()
    const { killLow: _a, killMid: _b, killTop: _c, ...keep } = next
    try {
      localStorage.setItem(LS, JSON.stringify(keep))
    } catch {
      /* not remembered */
    }
  }

  kill(band: 'low' | 'mid' | 'top', on: boolean): void {
    this.update(band === 'low' ? { killLow: on } : band === 'mid' ? { killMid: on } : { killTop: on })
  }

  /** Everything back to flat. */
  reset(): void {
    this.update({ ...DEFAULT })
  }
}

export const isolator = new Isolator()
