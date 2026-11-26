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
export type AuxFx = 'reverb' | 'flanger' | 'delay' | 'phaser' | 'dubecho' | 'spring' | 'sweep' | 'plate'

/** Echo times on the beat, in beats: 1/8, dotted 1/8 (the dub one), 1/4, dotted 1/4, 1/2, 3/4 of a bar. */
const DUB_BEATS = [0.5, 0.75, 1, 1.5, 2, 3]
const DUB_BEAT_NAMES = ['1/8', '1/8.', '1/4', '1/4.', '1/2', '3/4']
const DELAY_BEATS = [0.5, 1, 1.5, 2, 3, 4]
const DELAY_BEAT_NAMES = ['1/8', '1/4', '3/8', '1/2', '3/4', '1 bar']
const pick = (v: number, n: number) => Math.min(n - 1, Math.floor(v * n))

export const AUX_FX: { id: AuxFx; label: string; a: string; b: string; hint: string; fmtA?: (v: number) => string }[] = [
  {
    id: 'dubecho',
    label: 'Dub echo',
    a: 'TIME',
    b: 'FDBK',
    hint: "Tape echo the dub way: repeats that get darker and warmer, a little wow; past 3 o'clock it runs away",
    fmtA: (v) => DUB_BEAT_NAMES[pick(v, 6)],
  },
  { id: 'spring', label: 'Spring', a: 'DECAY', b: 'TONE', hint: 'Spring reverb: the boing of the tank, how long it rings and how bright' },
  { id: 'sweep', label: 'Sweep', a: 'RATE', b: 'RES', hint: 'A resonant filter that opens and closes by itself: how fast, how sharp' },
  { id: 'plate', label: 'Plate', a: 'SIZE', b: 'TONE', hint: 'Dense bright plate: snares and voices, short or long' },
  { id: 'reverb', label: 'Reverb', a: 'SIZE', b: 'TONE', hint: 'A room around the sound: size of the space, how bright it is' },
  {
    id: 'delay',
    label: 'Delay',
    a: 'TIME',
    b: 'FDBK',
    hint: 'Clean echo on the beat (1/8 to 1 bar) and how long it repeats',
    fmtA: (v) => DELAY_BEAT_NAMES[pick(v, 6)],
  },
  { id: 'flanger', label: 'Flanger', a: 'RATE', b: 'DEPTH', hint: 'The jet sweep: how fast and how deep' },
  { id: 'phaser', label: 'Phaser', a: 'RATE', b: 'DEPTH', hint: 'A swirling notch sweep: how fast and how deep' },
]

/** The tempo on air, as seconds per beat (half a second when unknown). */
function beatSeconds(): number {
  const live = liveDeck()?.get()
  return live?.bpm ? 60 / (live.bpm * (live.rate || 1)) : 0.5
}

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
  /** The dub scene on now (lit), or null. Pressing it again takes it off. */
  scene: DubSceneId | null
  /** The desk as it was before the scene went on: what taking the scene off goes back to. */
  sceneBase: { aux: AuxState[]; send: PluginState['send'] } | null
}

export type DubSceneId = 'tubby' | 'skank' | 'space' | 'dry'

/**
 * Ready-made dub setups for the two AUX: the effects and the sends (the same on both decks).
 * DRY keeps the effects and closes every send.
 */
export const DUB_SCENES: {
  id: DubSceneId
  label: string
  hint: string
  aux?: Partial<AuxState>[]
  send: Partial<Record<Stem, number>>[]
}[] = [
  {
    id: 'tubby',
    label: 'TUBBY',
    hint: 'The classic: dotted-1/8 tape echo on the voice, spring on the hats and a touch of the skank',
    aux: [
      { fx: 'dubecho', a: 0.2, b: 0.55, ret: 0.8 },
      { fx: 'spring', a: 0.45, b: 0.45, ret: 0.7 },
    ],
    send: [{ vocal: 0.55 }, { hat: 0.5, instr: 0.2 }],
  },
  {
    id: 'skank',
    label: 'SKANK ECHO',
    hint: 'Quarter-note echo on the instruments (the off-beat chops), a small plate on the voice',
    aux: [
      { fx: 'dubecho', a: 0.4, b: 0.45, ret: 0.75 },
      { fx: 'plate', a: 0.25, b: 0.6, ret: 0.6 },
    ],
    send: [{ instr: 0.65 }, { vocal: 0.3 }],
  },
  {
    id: 'space',
    label: 'SPACE',
    hint: 'Wide and floating: long plate on voice and instruments, a slow filter sweep on the hats',
    aux: [
      { fx: 'plate', a: 0.75, b: 0.55, ret: 0.7 },
      { fx: 'sweep', a: 0.3, b: 0.6, ret: 0.65 },
    ],
    send: [{ vocal: 0.45, instr: 0.3 }, { hat: 0.7 }],
  },
  { id: 'dry', label: 'DRY', hint: 'Every send closed; the effects stay as they are', send: [{}, {}] },
]

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
    } else if (fx === 'dubecho') {
      // input ─► delay ─► return; the repeats go round through a band (no mud, no fizz) and a soft
      // saturation, like tape; a slow wobble on the time is the tape's wow.
      const delay = ctx.createDelay(4)
      const fb = ctx.createGain()
      const hp = ctx.createBiquadFilter()
      const lp = ctx.createBiquadFilter()
      const sat = ctx.createWaveShaper()
      hp.type = 'highpass'
      hp.frequency.value = 280
      lp.type = 'lowpass'
      lp.frequency.value = 2600
      sat.curve = tanhCurve(1.6)
      const lfo = ctx.createOscillator()
      const wow = ctx.createGain()
      lfo.frequency.value = 0.55
      wow.gain.value = 0.0012
      lfo.connect(wow).connect(delay.delayTime)
      lfo.start()
      this.lfo = lfo
      this.input.connect(delay).connect(this.ret)
      delay.connect(hp).connect(lp).connect(sat).connect(fb).connect(delay)
      this.nodes = [delay, fb, hp, lp, sat, wow]
      this.set = (s) => {
        to(delay.delayTime, Math.min(3.9, beatSeconds() * DUB_BEATS[pick(s.a, 6)]))
        to(fb.gain, s.b * 0.97)
      }
    } else if (fx === 'spring' || fx === 'plate') {
      const pre = ctx.createDelay(0.1)
      pre.delayTime.value = fx === 'plate' ? 0.018 : 0.004
      const conv = ctx.createConvolver()
      const tone = ctx.createBiquadFilter()
      tone.type = 'lowpass'
      const low = ctx.createBiquadFilter()
      low.type = 'highpass'
      low.frequency.value = fx === 'spring' ? 220 : 160 // reverb on the bass is mud
      this.input.connect(low).connect(pre).connect(conv).connect(tone).connect(this.ret)
      this.nodes = [pre, conv, tone, low]
      let size = -1
      this.set = (s) => {
        const want = Math.round((fx === 'spring' ? 1 + s.a * 3 : 0.7 + s.a * 2.6) * 10) / 10
        if (want !== size) {
          size = want
          conv.buffer = fx === 'spring' ? springImpulse(ctx, want) : plateImpulse(ctx, want)
        }
        to(tone.frequency, 1800 * Math.pow(14000 / 1800, s.b))
      }
    } else if (fx === 'sweep') {
      // A resonant low-pass whose cutoff rides an LFO, in cents (so it sweeps evenly by ear).
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 900
      const lfo = ctx.createOscillator()
      const depth = ctx.createGain()
      depth.gain.value = 2600 // ± a little over two octaves
      lfo.type = 'triangle'
      lfo.connect(depth).connect(lp.detune)
      lfo.start()
      this.lfo = lfo
      this.input.connect(lp).connect(this.ret)
      this.nodes = [lp, depth]
      this.set = (s) => {
        to(lfo.frequency, 0.04 * Math.pow(2 / 0.04, s.a))
        to(lp.Q, 0.7 + s.b * 16)
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
        to(delay.delayTime, Math.min(3.9, beatSeconds() * DELAY_BEATS[pick(s.a, 6)]))
        to(fb.gain, s.b * 0.85)
      }
    }
  }
}

/** Soft saturation: tanh, `drive` sets how early it bends. */
function tanhCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(x * drive) / Math.tanh(drive)
  }
  return c
}

/**
 * A spring tank: the hit comes back again and again (each trip along the spring, ~33 ms), each time
 * smeared into a falling chirp (the spring's dispersion: highs arrive first), with a metallic ring.
 */
function springImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const n = Math.round(rate * seconds)
  const buf = ctx.createBuffer(2, n, rate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    const trip = (0.031 + c * 0.004) * rate // the two springs differ a little: stereo
    for (let k = 0; k * trip < n; k++) {
      const start = Math.round(k * trip)
      const amp = Math.pow(0.72, k) * (k % 2 ? -1 : 1)
      const len = Math.min(n - start, Math.round(0.028 * rate))
      let phase = 0
      for (let i = 0; i < len; i++) {
        const t = i / len
        phase += (2 * Math.PI * (3200 * Math.pow(180 / 3200, t))) / rate // chirp down
        d[start + i] += amp * Math.sin(phase) * (1 - t) * 0.6
      }
    }
    // The tank's ring and hiss under it, fading with the tail.
    for (let i = 0; i < n; i++) {
      const env = Math.pow(1 - i / n, 2.6)
      d[i] += (Math.random() * 2 - 1) * 0.12 * env + Math.sin((2 * Math.PI * 1850 * i) / rate) * 0.05 * env
    }
  }
  return buf
}

/** A plate: dense and bright from the first instant, smooth, darker as it fades. */
function plateImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const n = Math.round(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, n, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let low = 0
    for (let i = 0; i < n; i++) {
      const t = i / n
      low += (Math.random() * 2 - 1 - low) * (0.9 - 0.55 * t)
      d[i] = low * Math.exp(-5 * t)
    }
  }
  return buf
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
    const base = s.sceneBase
    const baseOk = !!base && Array.isArray(base.aux) && base.aux.length === 2 && Array.isArray(base.send) && base.send.length === 2
    const scene = baseOk && DUB_SCENES.some((x) => x.id === s.scene) ? (s.scene as DubSceneId) : null
    super({ aux, send, scene, sceneBase: scene ? base! : null })
    this.units = aux.map(() => new Aux(mixer.ctx))
    decks.forEach((d) => d.auxPost.forEach((post, i) => post.connect(this.units[i].input)))
    this.units.forEach((u, i) => u.apply(aux[i]))
    this.pushSends()
    // A synced delay follows the tempo of what is on air.
    window.setInterval(() => this.state.aux.forEach((a, i) => (a.fx === 'delay' || a.fx === 'dubecho') && this.units[i].apply(a)), 2000)
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

  /**
   * A ready-made dub setup: both AUX effects and every send at once (see DUB_SCENES). It toggles: the lit
   * scene pressed again goes back to the desk exactly as it was before the first scene went on; another
   * scene switches over and keeps that same way back. Knob moves while a scene is on are part of the scene.
   */
  applyScene(id: DubSceneId): void {
    if (this.state.scene === id) return this.sceneOff()
    const scene = DUB_SCENES.find((x) => x.id === id)
    if (!scene) return
    const base = this.state.sceneBase ?? { aux: this.state.aux.map((a) => ({ ...a })), send: structuredClone(this.state.send) }
    const aux = scene.aux ? scene.aux.map((a, i) => ({ ...base.aux[i], ...a })) : this.state.aux
    const send = [0, 1].map((i) => {
      const both = { ...zero(), ...(scene.send[i] ?? {}) }
      return { A: { ...both }, B: { ...both } }
    })
    this.set({ aux, send, scene: id, sceneBase: base })
    aux.forEach((a, i) => this.units[i].apply(a))
    this.pushSends()
    this.persist()
  }

  /** The scene off: back to the desk from before it (sends and returns glide there, no click). */
  sceneOff(): void {
    const base = this.state.sceneBase
    if (!base) return void (this.state.scene && this.set({ scene: null }))
    this.set({ aux: base.aux, send: base.send, scene: null, sceneBase: null })
    base.aux.forEach((a, i) => this.units[i].apply(a))
    this.pushSends()
    this.persist()
  }

  /**
   * A move on one send, on top of what the knob says (the AI dub pads ride the desk with this): from
   * `at` seconds from now, up to `level` in `attack`, held `hold`, back to the knob's value in `release`.
   */
  ride(i: number, deck: 'A' | 'B', stem: Stem, level: number, o: { at?: number; attack?: number; hold: number; release?: number }): void {
    const d = decks.find((x) => x.name === deck)
    if (!d) return
    const g = d.auxSend[i][stem].gain
    const start = mixer.ctx.currentTime + Math.max(0, o.at ?? 0)
    const base = this.state.send[i][deck][stem]
    const attack = o.attack ?? 0.01
    g.cancelScheduledValues(start)
    g.setTargetAtTime(Math.max(base, level), start, attack / 3)
    g.setTargetAtTime(base, start + attack + o.hold, (o.release ?? 0.2) / 3)
  }

  /** Every send back to what its knob says (after the AI pads stop). */
  settle(): void {
    const now = mixer.ctx.currentTime
    for (const d of decks) for (const sends of d.auxSend) for (const g of Object.values(sends)) g.gain.cancelScheduledValues(now)
    this.pushSends()
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
