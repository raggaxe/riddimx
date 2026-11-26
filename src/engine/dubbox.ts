import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { decks } from './deck'
import { sampler } from './sampler'
import { choke } from './choke'
import { sfx, sfxLabel } from './soundsystem'

/**
 * Dub Box: a third input on the mixer, played live over the music like a sound system's siren box.
 *
 *   voice (siren · noise · spring) ─► tone ─┐
 *   sampler pads (when routed here) ────────┴► channel filter ─┬─► mix ─► level ─► master
 *                                                               └► echo send ─► low cut ─► delay ⟲ (darker each repeat)
 *                                                                                   └► echo return ─► mix
 *                                                                                                  └► spring ─► mix
 *   mix ─► headphones (when its pre-listen button is on)
 *
 * The same few controls mean slightly different things per voice, so one set of knobs plays all three:
 *   pitch: siren note / noise filter / spring tone · sweep: one bend on each press ·
 *   wobble (LFO): moves the pitch (siren) or the filter (noise, spring).
 */

export type Voice = 'siren' | 'noise' | 'spring' | 'sample'
export type LfoShape = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'random'
export type NoiseColor = 'white' | 'pink' | 'brown'

export interface Patch {
  voice: Voice
  wave: OscillatorType // siren
  color: NoiseColor // noise, spring
  pitch: number // Hz
  resonance: number // dB, noise / spring filter
  tone: number // Hz, low-pass on the voice
  lfoShape: LfoShape
  lfoRate: number // Hz
  lfoDepth: number // semitones
  sweep: number // semitones, bend on each press
  sweepTime: number // seconds
  attack: number // seconds
  release: number // seconds
  echo: number // 0..1 send into the channel echo
  echoBeats: number // echo time in beats of the playing deck
  feedback: number // 0..0.95
  echoTone: number // Hz, each repeat is darkened here
  spring: number // 0..1 spring reverb on the channel
  sample: string | null // sample voice: 'sfx:<id>' (comes with the app) or 'file:<uuid>' (the DJ's own)
  sampleName: string
  loop: boolean // sample: repeats while FIRE is held (off = plays once, to its end)
  reverse: boolean
  start: number // 0..0.95: where in the sample it starts
}

export const PATCH_LIMITS = {
  pitch: [40, 4000],
  resonance: [0, 24],
  tone: [300, 12000],
  lfoRate: [0.05, 20],
  lfoDepth: [0, 24],
  sweep: [-48, 48],
  sweepTime: [0.03, 4],
  attack: [0.002, 2],
  release: [0.02, 4],
  echo: [0, 1],
  feedback: [0, 0.95],
  echoTone: [600, 10000],
  spring: [0, 1],
  start: [0, 0.95],
} as const

/** Drag type of a Dub Box preset chip being dragged onto a quick button (the data is its name). */
export const DUB_PRESET_DRAG = 'application/x-vx-dubpreset'

export const ECHO_BEATS = [0.25, 0.5, 0.75, 1, 1.5, 2]

const base: Patch = {
  voice: 'siren',
  wave: 'square',
  color: 'white',
  pitch: 440,
  resonance: 0,
  tone: 3500,
  lfoShape: 'triangle',
  lfoRate: 1.6,
  lfoDepth: 7,
  sweep: 0,
  sweepTime: 0.4,
  attack: 0.01,
  release: 0.4,
  echo: 0.5,
  echoBeats: 0.75,
  feedback: 0.6,
  echoTone: 2500,
  spring: 0.2,
  sample: null,
  sampleName: '',
  loop: false,
  reverse: false,
  start: 0,
}

/** Factory sounds were renamed when the interface went English: saved choices keep working. */
const OLD_NAMES: Record<string, string> = {
  'Sirene clássica': 'Classic siren',
  Alarme: 'Alarm',
  Polícia: 'Police',
  Trovão: 'Thunder',
  Vento: 'Wind',
  'Tom pew': 'Pew tom',
  Mola: 'Spring',
}
const renamed = (name: string): string => OLD_NAMES[name] ?? name

export const FACTORY: { name: string; patch: Patch }[] = [
  { name: 'Classic siren', patch: base },
  {
    name: 'Alarm',
    patch: { ...base, pitch: 700, lfoShape: 'square', lfoRate: 4, lfoDepth: 5, tone: 4000, echo: 0.35, echoBeats: 0.5 },
  },
  {
    name: 'Laser',
    patch: {
      ...base,
      wave: 'sawtooth',
      pitch: 1800,
      lfoDepth: 0,
      sweep: -36,
      sweepTime: 0.35,
      release: 0.15,
      echo: 0.6,
      echoBeats: 0.5,
      feedback: 0.7,
      tone: 6000,
    },
  },
  {
    name: 'Police',
    patch: { ...base, wave: 'triangle', pitch: 620, lfoShape: 'sine', lfoRate: 0.35, lfoDepth: 12, tone: 4000, echo: 0.3 },
  },
  {
    name: 'Zip',
    patch: { ...base, pitch: 220, lfoShape: 'sawtooth', lfoRate: 6, lfoDepth: 12, echo: 0.55, feedback: 0.65 },
  },
  {
    name: 'Thunder',
    patch: {
      ...base,
      voice: 'noise',
      color: 'brown',
      pitch: 140,
      resonance: 2,
      tone: 2000,
      lfoShape: 'random',
      lfoRate: 8,
      lfoDepth: 10,
      sweep: -12,
      sweepTime: 2,
      attack: 0.05,
      release: 2.5,
      echo: 0.2,
      spring: 0.5,
    },
  },
  {
    name: 'Whoosh',
    patch: {
      ...base,
      voice: 'noise',
      color: 'white',
      pitch: 200,
      resonance: 8,
      tone: 9000,
      lfoDepth: 0,
      sweep: 48,
      sweepTime: 1.4,
      attack: 0.2,
      release: 0.6,
      echo: 0.45,
      echoBeats: 1,
    },
  },
  {
    name: 'Wind',
    patch: {
      ...base,
      voice: 'noise',
      color: 'pink',
      pitch: 800,
      resonance: 10,
      tone: 6000,
      lfoShape: 'sine',
      lfoRate: 0.3,
      lfoDepth: 18,
      attack: 0.6,
      release: 1.5,
      echo: 0.1,
      spring: 0.3,
    },
  },
  {
    // The classic dub "pew": a synth drum whose pitch falls fast, thrown into the echo.
    name: 'Pew tom',
    patch: {
      ...base,
      wave: 'sine',
      pitch: 620,
      lfoDepth: 0,
      sweep: -30,
      sweepTime: 0.25,
      attack: 0.002,
      release: 0.35,
      echo: 0.6,
      echoBeats: 0.75,
      feedback: 0.65,
      tone: 5000,
    },
  },
  {
    // A gunshot cue: a sharp noise burst with a falling filter, into the spring and echo.
    name: 'Lickshot',
    patch: {
      ...base,
      voice: 'noise',
      color: 'white',
      pitch: 1500,
      resonance: 4,
      tone: 9000,
      lfoDepth: 0,
      sweep: -36,
      sweepTime: 0.18,
      attack: 0.001,
      release: 0.22,
      echo: 0.55,
      echoBeats: 0.5,
      spring: 0.3,
    },
  },
  {
    name: 'Spring',
    patch: {
      ...base,
      voice: 'spring',
      color: 'white',
      pitch: 3000,
      resonance: 3,
      tone: 8000,
      lfoDepth: 0,
      release: 3,
      echo: 0.3,
      echoBeats: 1,
      spring: 0,
    },
  },
]

export interface DubBoxState {
  patch: Patch
  preset: string | null // name of the preset the patch came from (null once edited)
  user: { name: string; patch: Patch }[] // presets saved by the DJ
  level: number // channel fader 0..1
  filter: number // -1..1 like the deck filter
  pfl: boolean
  mode: 'hold' | 'latch' // FIRE works while held, or one press on / one press off
  followKey: boolean // siren snaps to the key of the playing deck
  slots: ({ name: string; patch: Patch } | null)[] // 4 quick buttons on the mixer, each a whole sound
  slotPlaying: number | null
  rehearse: boolean // the Dub Box is heard only in the headphones (to try sounds off-air)
  basePreset: string | null // last preset chosen, for the Repor button
  sampler: boolean // the sampler pads play through this channel (its filter, echo and spring)
  playing: boolean
  throwing: boolean
}

const LS = 'vx_dubbox'

function restore(): DubBoxState {
  const fresh: DubBoxState = {
    patch: base,
    preset: FACTORY[0].name,
    user: [],
    level: 0.8,
    filter: 0,
    pfl: false,
    mode: 'hold',
    followKey: false,
    sampler: false,
    slots: ['Classic siren', 'Laser', 'Whoosh', 'Spring'].map((name) => ({ name, patch: FACTORY.find((f) => f.name === name)!.patch })),
    slotPlaying: null,
    rehearse: false,
    basePreset: FACTORY[0].name,
    playing: false,
    throwing: false,
  }
  try {
    const saved = JSON.parse(localStorage.getItem(LS) || '{}')
    const slots = Array.isArray(saved.slots)
      ? saved.slots.slice(0, 4).map((x: { name: string; patch: Patch } | null) => x && { name: renamed(x.name), patch: { ...base, ...x.patch } })
      : fresh.slots
    if (typeof saved.preset === 'string') saved.preset = renamed(saved.preset)
    if (typeof saved.basePreset === 'string') saved.basePreset = renamed(saved.basePreset)
    return {
      ...fresh,
      ...saved,
      slots,
      patch: { ...base, ...saved.patch },
      playing: false,
      throwing: false,
      rehearse: false,
      slotPlaying: null,
    }
  } catch {
    return fresh
  }
}

/** Noise of each colour: 4 s, looped. */
function noiseBuffer(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  const length = ctx.sampleRate * 4
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const d = buffer.getChannelData(0)
  let b0 = 0,
    b1 = 0,
    b2 = 0,
    b3 = 0,
    b4 = 0,
    b5 = 0,
    b6 = 0,
    last = 0
  for (let i = 0; i < length; i++) {
    const w = Math.random() * 2 - 1
    if (color === 'white') d[i] = w * 0.5
    else if (color === 'pink') {
      // Paul Kellet's filter
      b0 = 0.99886 * b0 + w * 0.0555179
      b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852
      b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522
      b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    } else {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    }
  }
  return buffer
}

/**
 * Spring tank: each bounce along the spring is a quick falling chirp (high notes arrive first),
 * repeating and fading, over a soft metallic hiss.
 */
function springImpulse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.floor(rate * 3)
  const buffer = ctx.createBuffer(2, length, rate)
  for (let c = 0; c < 2; c++) {
    const d = buffer.getChannelData(c)
    const gap = 0.055 + c * 0.007
    for (let k = 0; k * gap < 2.8; k++) {
      const start = Math.floor((k * gap + 0.01) * rate)
      const amp = Math.pow(0.78, k)
      const len = Math.floor(0.045 * rate)
      let phase = 0
      for (let i = 0; i < len && start + i < length; i++) {
        const t = i / len
        const f = 4200 * Math.pow(300 / 4200, t)
        phase += (2 * Math.PI * f) / rate
        d[start + i] += Math.sin(phase) * amp * (1 - t) * 0.5
      }
    }
    for (let i = 0; i < length; i++) d[i] += (Math.random() * 2 - 1) * 0.06 * Math.pow(1 - i / length, 4)
  }
  return buffer
}

/** Pitch class of a key name like "A#m" or "Eb" (C = 0), or null. */
function keyRoot(key: string | null): number | null {
  const m = key ? /^([A-G])(#|b)?/.exec(key) : null
  if (!m) return null
  const steps: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
  return (steps[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12
}

const DB = 'vx-dubbox'

function idb<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB, 1)
    open.onupgradeneeded = () => open.result.createObjectStore('samples')
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const request = run(open.result.transaction('samples', mode).objectStore('samples'))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    }
  })
}

/**
 * Cuts the silence at both ends of a sample (keeping 5 ms), so it speaks the moment FIRE is pressed,
 * forwards or backwards.
 */
function trimmed(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const loud = (i: number): boolean => {
    for (let c = 0; c < buffer.numberOfChannels; c++) if (Math.abs(buffer.getChannelData(c)[i]) > 0.003) return true
    return false
  }
  let first = 0
  let last = buffer.length - 1
  while (first < last && !loud(first)) first++
  while (last > first && !loud(last)) last--
  const pad = Math.floor(buffer.sampleRate * 0.005)
  first = Math.max(0, first - pad)
  last = Math.min(buffer.length - 1, last + pad)
  if (first === 0 && last === buffer.length - 1) return buffer
  const out = ctx.createBuffer(buffer.numberOfChannels, last - first + 1, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).subarray(first, last + 1))
  return out
}

function reversed(ctx: BaseAudioContext, buffer: AudioBuffer): AudioBuffer {
  const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate)
  for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).slice().reverse())
  return out
}

const pick = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]
const between = (lo: number, hi: number): number => lo + Math.random() * (hi - lo)
const logBetween = (lo: number, hi: number): number => lo * Math.pow(hi / lo, Math.random())

interface Sounding {
  kind: Voice
  patch: Patch
  stop(at: number): void
  target: AudioParam // what pitch / sweep / wobble move (oscillator or filter detune)
  frequency: AudioParam // base pitch of that target
  osc?: OscillatorNode
  lfo: OscillatorNode | ConstantSourceNode
  lfoGain: GainNode
  tone: BiquadFilterNode
  filter?: BiquadFilterNode
  end: number // when it has fully died away (Infinity while held)
}

class DubBox extends Store<DubBoxState> {
  /** Anything plugged into the Dub Box (the sampler, when routed here) goes in here. */
  readonly input: GainNode
  readonly meterTap: GainNode
  private ctx: AudioContext
  private chFilter: BiquadFilterNode
  private echoSend: GainNode
  private delay: DelayNode
  private feedbackGain: GainNode
  private echoDark: BiquadFilterNode
  private springGain: GainNode
  private level: GainNode
  private pflSend: GainNode
  private springIr: AudioBuffer
  private noises = new Map<NoiseColor, AudioBuffer>()
  private voice: Sounding | null = null
  private samples = new Map<string, AudioBuffer>()
  private reversedCache = new Map<string, AudioBuffer>()
  private toMaster: GainNode

  constructor() {
    super(restore())
    const ctx = mixer.ctx
    this.ctx = ctx
    const gain = (v: number): GainNode => {
      const g = ctx.createGain()
      g.gain.value = v
      return g
    }
    this.springIr = springImpulse(ctx)
    this.input = gain(1)
    this.chFilter = ctx.createBiquadFilter()
    this.chFilter.type = 'allpass'
    const mix = gain(1)
    this.level = gain(this.state.level)
    this.meterTap = this.level
    this.input.connect(this.chFilter)
    this.chFilter.connect(mix)

    this.echoSend = gain(0)
    const lowCut = ctx.createBiquadFilter()
    lowCut.type = 'highpass'
    lowCut.frequency.value = 150
    this.delay = ctx.createDelay(6)
    this.feedbackGain = gain(0.6)
    this.echoDark = ctx.createBiquadFilter()
    this.echoDark.type = 'lowpass'
    this.echoDark.Q.value = -3 // no resonant bump: the loop must never gain
    this.chFilter.connect(this.echoSend)
    this.echoSend.connect(lowCut)
    lowCut.connect(this.delay)
    this.delay.connect(this.echoDark)
    this.echoDark.connect(this.feedbackGain)
    this.feedbackGain.connect(this.delay)
    this.echoDark.connect(mix)

    const spring = ctx.createConvolver()
    spring.buffer = this.springIr
    this.springGain = gain(0)
    mix.connect(spring)
    spring.connect(this.springGain)
    this.springGain.connect(this.level)
    mix.connect(this.level)
    this.toMaster = gain(1)
    this.level.connect(this.toMaster)
    this.toMaster.connect(mixer.masterGain)

    this.pflSend = gain(this.state.pfl ? 1 : 0)
    mix.connect(this.pflSend)
    this.pflSend.connect(mixer.cueBus)

    this.applyChannel()
    this.applyPatch()
    if (this.state.sampler) sampler.route(this.input)
    // Decode every sample in use up front, so the first press already plays.
    for (const ref of [this.state.patch, ...this.state.user.map((u) => u.patch), ...this.state.slots.map((x) => x?.patch)]) {
      if (ref?.sample) void this.ensureSample(ref.sample)
    }
    // Keep the echo on the beat of whatever is playing.
    window.setInterval(() => this.retime(), 500)
  }

  // ───────────────────────── playing ─────────────────────────

  /** FIRE pressed (true) or released (false), following the hold / latch mode. */
  fire(down: boolean): void {
    if (this.state.mode === 'latch') {
      if (down) this.state.playing ? this.release() : this.trigger(this.state.patch)
    } else if (down) this.trigger(this.state.patch)
    else if (this.state.slotPlaying === null) this.release()
  }

  /** One of the 4 quick buttons. An empty one takes the current sound. */
  fireSlot(index: number, down: boolean): void {
    const slot = this.state.slots[index]
    if (!slot) {
      if (down) this.assignSlot(index)
      return
    }
    if (this.state.mode === 'latch') {
      if (down) this.state.slotPlaying === index ? this.release() : this.trigger(slot.patch, index)
    } else if (down) this.trigger(slot.patch, index)
    else if (this.state.slotPlaying === index) this.release()
  }

  trigger(p: Patch = this.state.patch, slot: number | null = null): void {
    mixer.resume()
    this.release()
    this.applyEcho(p)
    this.retime(p)
    let sound: Sounding | null
    if (p.voice === 'siren') sound = this.siren(p)
    else if (p.voice === 'noise') sound = this.noise(p)
    else if (p.voice === 'spring') sound = this.springHit(p)
    else {
      sound = this.sampleVoice(p)
      if (!sound) {
        // Not decoded yet (first use after starting the app): play it as soon as it is ready.
        void this.ensureSample(p.sample).then((ok) => ok && this.trigger(p, slot))
        return
      }
    }
    this.voice = sound
    // The spring and one-shot samples play out on their own; the rest sound while held.
    const sustained = p.voice === 'siren' || p.voice === 'noise' || (p.voice === 'sample' && p.loop)
    this.set({ playing: sustained && slot === null, slotPlaying: sustained ? slot : null })
  }

  release(): void {
    const v = this.voice
    this.voice = null
    if (v) v.stop(this.ctx.currentTime)
    if (this.state.playing || this.state.slotPlaying !== null) this.set({ playing: false, slotPlaying: null })
  }

  /**
   * AI FIRE: plays a sound that is not the patch on the FIRE key (sustained ones for `hold` seconds), and
   * afterwards puts the echo back the way the FIRE patch has it, once its tail has gone. Returns a stop.
   */
  aiShot(p: Patch, hold: number): () => void {
    window.clearTimeout(this.aiTimer)
    this.trigger(p)
    const mine = this.voice
    const restore = () => {
      if (this.voice && this.voice !== mine) return // the DJ fired something since: theirs now
      this.applyEcho(this.state.patch)
    }
    const stop = () => {
      window.clearTimeout(this.aiTimer)
      if (this.voice === mine) this.release()
      this.aiTimer = window.setTimeout(restore, 2500)
    }
    this.aiTimer = window.setTimeout(stop, Math.max(0.05, hold) * 1000)
    return stop
  }
  private aiTimer = 0

  /** PANIC: the sound stops, THROW let go, the echo stops repeating. */
  panic(): void {
    this.release()
    if (this.state.throwing) this.throw(false)
    choke(this.feedbackGain.gain, this.ctx)
  }

  /** Throw: everything goes into the echo while held. */
  throw(held: boolean): void {
    this.set({ throwing: held })
    this.echoSend.gain.setTargetAtTime(held ? 1 : this.state.patch.echo, this.ctx.currentTime, 0.01)
  }

  private envelope(out: GainNode, peak: number, p: Patch): (at: number) => void {
    const now = this.ctx.currentTime
    out.gain.setValueAtTime(0, now)
    out.gain.linearRampToValueAtTime(peak, now + p.attack)
    return (at) => {
      out.gain.cancelScheduledValues(at)
      out.gain.setValueAtTime(out.gain.value, at)
      out.gain.setTargetAtTime(0, at, p.release / 5)
    }
  }

  private makeLfo(target: AudioParam, p: Patch): { lfo: OscillatorNode | ConstantSourceNode; lfoGain: GainNode } {
    const lfoGain = this.ctx.createGain()
    lfoGain.gain.value = p.lfoDepth * 100
    let lfo: OscillatorNode | ConstantSourceNode
    if (p.lfoShape === 'random') {
      // Sample-and-hold: a new random value on every step, scheduled ahead.
      const steps = this.ctx.createConstantSource()
      const now = this.ctx.currentTime
      const count = Math.min(4000, Math.ceil(120 * p.lfoRate))
      for (let i = 0; i < count; i++) steps.offset.setValueAtTime(Math.random() * 2 - 1, now + i / p.lfoRate)
      lfo = steps
    } else {
      const osc = this.ctx.createOscillator()
      osc.type = p.lfoShape
      osc.frequency.value = p.lfoRate
      lfo = osc
    }
    lfo.connect(lfoGain)
    lfoGain.connect(target)
    lfo.start()
    return { lfo, lfoGain }
  }

  private sweep(target: AudioParam, p: Patch): void {
    const now = this.ctx.currentTime
    target.setValueAtTime(0, now)
    if (p.sweep !== 0) target.linearRampToValueAtTime(p.sweep * 100, now + p.sweepTime)
  }

  private voiceTone(p: Patch): BiquadFilterNode {
    const tone = this.ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = p.tone
    tone.connect(this.input)
    return tone
  }

  /** Siren pitch, snapped to the key of the playing deck when asked. */
  private sirenPitch(p: Patch): number {
    if (!this.state.followKey) return p.pitch
    const playing = decks.filter((d) => d.get().playing && d.get().key)
    const root = keyRoot(playing[0]?.get().key ?? null)
    if (root === null) return p.pitch
    // Nearest note with that pitch class (A4 = 440 Hz = MIDI 69).
    const midi = 69 + 12 * Math.log2(p.pitch / 440)
    const below = Math.floor((midi - root) / 12) * 12 + root
    const best = midi - below < below + 12 - midi ? below : below + 12
    return 440 * Math.pow(2, (best - 69) / 12)
  }

  private siren(p: Patch): Sounding {
    const ctx = this.ctx
    const tone = this.voiceTone(p)
    const env = ctx.createGain()
    env.connect(tone)
    const osc = ctx.createOscillator()
    osc.type = p.wave
    osc.frequency.value = this.sirenPitch(p)
    osc.connect(env)
    this.sweep(osc.detune, p)
    const { lfo, lfoGain } = this.makeLfo(osc.detune, p)
    const fade = this.envelope(env, p.wave === 'sine' || p.wave === 'triangle' ? 0.45 : 0.22, p)
    osc.start()
    return {
      kind: 'siren',
      patch: p,
      target: osc.detune,
      frequency: osc.frequency,
      osc,
      lfo,
      lfoGain,
      tone,
      end: Infinity,
      stop: (at) => {
        fade(at)
        const off = at + p.release + 0.1
        osc.stop(off)
        lfo.stop(off)
        osc.onended = () => tone.disconnect()
      },
    }
  }

  private noiseOf(color: NoiseColor): AudioBuffer {
    let b = this.noises.get(color)
    if (!b) {
      b = noiseBuffer(this.ctx, color)
      this.noises.set(color, b)
    }
    return b
  }

  private noise(p: Patch): Sounding {
    const ctx = this.ctx
    const tone = this.voiceTone(p)
    const env = ctx.createGain()
    env.connect(tone)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = p.pitch
    filter.Q.value = p.resonance
    filter.connect(env)
    const src = ctx.createBufferSource()
    src.buffer = this.noiseOf(p.color)
    src.loop = true
    src.connect(filter)
    this.sweep(filter.detune, p)
    const { lfo, lfoGain } = this.makeLfo(filter.detune, p)
    const fade = this.envelope(env, 0.8, p)
    src.start(0, Math.random() * 3) // a different stretch each time
    return {
      kind: 'noise',
      patch: p,
      target: filter.detune,
      frequency: filter.frequency,
      filter,
      lfo,
      lfoGain,
      tone,
      end: Infinity,
      stop: (at) => {
        fade(at)
        const off = at + p.release + 0.1
        src.stop(off)
        lfo.stop(off)
        src.onended = () => tone.disconnect()
      },
    }
  }

  /** Kicking the spring tank: a short burst of noise into its own spring. */
  private springHit(p: Patch): Sounding {
    const ctx = this.ctx
    const tone = this.voiceTone(p)
    const tank = ctx.createConvolver()
    tank.buffer = this.springIr
    const tankOut = ctx.createGain()
    tankOut.gain.value = 1.6
    tank.connect(tankOut)
    tankOut.connect(tone)
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.value = p.pitch
    filter.Q.value = p.resonance
    filter.connect(tank)
    const burst = ctx.createGain()
    burst.connect(filter)
    const src = ctx.createBufferSource()
    src.buffer = this.noiseOf(p.color)
    src.connect(burst)
    const now = ctx.currentTime
    burst.gain.setValueAtTime(1, now)
    burst.gain.setTargetAtTime(0, now + 0.01, 0.025)
    this.sweep(filter.detune, p)
    const { lfo, lfoGain } = this.makeLfo(filter.detune, p)
    src.start(now, Math.random() * 3)
    src.stop(now + 0.2)
    const ring = now + Math.min(3, p.release) + 0.1
    lfo.stop(ring)
    // The tank rings on after the burst; cut it after the release time.
    tankOut.gain.setValueAtTime(1.6, now + Math.max(0.05, p.release - 0.3))
    tankOut.gain.linearRampToValueAtTime(0, now + p.release)
    window.setTimeout(() => tone.disconnect(), (p.release + 3.2) * 1000)
    return {
      kind: 'spring',
      patch: p,
      target: filter.detune,
      frequency: filter.frequency,
      filter,
      lfo,
      lfoGain,
      tone,
      end: ring,
      stop: () => undefined,
    }
  }

  /** The DJ's own sound (or one that comes with the app), with pitch, wobble, sweep and envelope. */
  private sampleVoice(p: Patch): Sounding | null {
    const key = p.sample
    const buffer = key ? this.samples.get(key) : null
    if (!key || !buffer) return null
    let played = buffer
    if (p.reverse) {
      played = this.reversedCache.get(key) ?? reversed(this.ctx, buffer)
      this.reversedCache.set(key, played)
    }
    const ctx = this.ctx
    const tone = this.voiceTone(p)
    const env = ctx.createGain()
    env.connect(tone)
    const src = ctx.createBufferSource()
    src.buffer = played
    src.playbackRate.value = p.pitch / 440
    const from = p.start * played.duration
    if (p.loop) {
      src.loop = true
      src.loopStart = from
      src.loopEnd = played.duration
    }
    src.connect(env)
    this.sweep(src.detune, p)
    const { lfo, lfoGain } = this.makeLfo(src.detune, p)
    const fade = this.envelope(env, 0.9, p)
    src.start(0, from)
    const end = p.loop ? Infinity : ctx.currentTime + (played.duration - from) / (p.pitch / 440) + 0.1
    src.onended = () => {
      lfo.stop()
      tone.disconnect()
      if (this.voice?.frequency === src.playbackRate) this.voice = null
    }
    return {
      kind: 'sample',
      patch: p,
      target: src.detune,
      frequency: src.playbackRate,
      lfo,
      lfoGain,
      tone,
      end,
      stop: (at) => {
        if (!p.loop) return // one shot: plays to its end
        fade(at)
        src.stop(at + p.release + 0.1)
      },
    }
  }

  /** Decodes a sample (from the app's sounds or the DJ's saved files) so it can play instantly. */
  private async ensureSample(key: string | null): Promise<boolean> {
    if (!key) return false
    if (this.samples.has(key)) return true
    try {
      let buffer: AudioBuffer | null = null
      if (key.startsWith('sfx:')) buffer = await sfx(key.slice(4))
      else {
        const saved = await idb<{ data: ArrayBuffer } | undefined>('readonly', (st) => st.get(key))
        if (saved) buffer = await this.ctx.decodeAudioData(saved.data.slice(0))
      }
      if (buffer) this.samples.set(key, trimmed(this.ctx, buffer))
      return !!buffer
    } catch {
      return false
    }
  }

  /** Makes an audio file of the DJ's the Dub Box voice, keeping it for next time. */
  async loadSampleFile(file: File): Promise<boolean> {
    try {
      const data = await file.arrayBuffer()
      const buffer = await this.ctx.decodeAudioData(data.slice(0))
      const key = 'file:' + crypto.randomUUID()
      await idb('readwrite', (st) => st.put({ name: file.name, data }, key))
      this.samples.set(key, trimmed(this.ctx, buffer))
      this.useSample(key, file.name.replace(/\.[^.]+$/, ''))
      return true
    } catch {
      return false
    }
  }

  /** One of the sound-system effects that come with the app, as the Dub Box voice. */
  async useSfx(id: string): Promise<void> {
    const key = 'sfx:' + id
    if (await this.ensureSample(key)) this.useSample(key, sfxLabel(id))
  }

  private useSample(key: string, name: string): void {
    this.release()
    const p = this.state.patch
    const keep = p.voice === 'sample' // already on a sample: keep how it is set up, change only the sound
    this.updatePatch(
      keep
        ? { sample: key, sampleName: name }
        : {
            voice: 'sample',
            sample: key,
            sampleName: name,
            pitch: 440,
            lfoDepth: 0,
            sweep: 0,
            attack: 0.003,
            release: 0.3,
            loop: false,
            reverse: false,
            start: 0,
            tone: 12000,
          },
    )
  }

  // ───────────────────────── settings ─────────────────────────

  /** Changes to the sound itself; also heard on a voice that is sounding now. */
  updatePatch(change: Partial<Patch>): void {
    const patch = { ...this.state.patch, ...change }
    for (const key of Object.keys(PATCH_LIMITS) as (keyof typeof PATCH_LIMITS)[]) {
      patch[key] = clamp(patch[key], PATCH_LIMITS[key][0], PATCH_LIMITS[key][1])
    }
    if (!ECHO_BEATS.includes(patch.echoBeats)) patch.echoBeats = base.echoBeats
    const voiceChanged = patch.voice !== this.state.patch.voice
    this.set({ patch, preset: null })
    if (voiceChanged) this.release()
    this.applyPatch()
    this.save()
  }

  usePreset(name: string): void {
    const found = [...FACTORY, ...this.state.user].find((p) => p.name === name)
    if (!found) return
    this.release()
    this.set({ patch: { ...base, ...found.patch }, preset: found.name, basePreset: found.name })
    if (found.patch.sample) void this.ensureSample(found.patch.sample)
    this.applyPatch()
    this.save()
  }

  /** Next / previous preset (factory first, then the DJ's own), for the controller. */
  stepPreset(dir: 1 | -1): void {
    const all = [...FACTORY, ...this.state.user]
    // After a tweak (or a surprise) the patch has no preset name: step from the one it came from,
    // not from the start of the list.
    const at = all.findIndex((p) => p.name === (this.state.preset ?? this.state.basePreset))
    this.usePreset(all[(at + dir + all.length) % all.length].name)
  }

  savePreset(name: string): void {
    const clean = name.trim().slice(0, 30)
    if (!clean || FACTORY.some((p) => p.name === clean)) return
    const user = [...this.state.user.filter((p) => p.name !== clean), { name: clean, patch: this.state.patch }]
    this.set({ user, preset: clean })
    this.save()
  }

  deletePreset(name: string): void {
    this.set({ user: this.state.user.filter((p) => p.name !== name), preset: this.state.preset === name ? null : this.state.preset })
    this.save()
  }

  /** Repor: back to the preset last chosen, undoing the tweaks. */
  resetToPreset(): void {
    if (this.state.basePreset) this.usePreset(this.state.basePreset)
  }

  /** Surpresa: a random variation of the current voice, inside ranges that sound musical. */
  surprise(): void {
    const p = this.state.patch
    const echo = {
      echo: between(0.25, 0.7),
      feedback: between(0.35, 0.8),
      echoBeats: pick([0.5, 0.75, 1]),
      echoTone: logBetween(1500, 5000),
      spring: between(0, 0.45),
    }
    const wobble = { lfoShape: pick(['sine', 'triangle', 'sawtooth', 'square', 'random'] as LfoShape[]), lfoRate: logBetween(0.2, 8) }
    const sweep = Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? -1 : 1) * between(5, 30)
    let change: Partial<Patch>
    if (p.voice === 'siren') {
      change = {
        wave: pick(['square', 'sawtooth', 'triangle'] as OscillatorType[]),
        pitch: logBetween(200, 1400),
        tone: logBetween(2000, 7000),
        lfoDepth: between(2, 14),
        sweep,
        sweepTime: logBetween(0.1, 1),
        ...wobble,
        ...echo,
      }
    } else if (p.voice === 'noise') {
      change = {
        color: pick(['white', 'pink', 'brown'] as NoiseColor[]),
        pitch: logBetween(100, 2500),
        resonance: between(0, 14),
        lfoDepth: between(0, 18),
        sweep: sweep * 1.5,
        sweepTime: logBetween(0.3, 2),
        attack: logBetween(0.01, 0.5),
        release: logBetween(0.3, 2),
        ...wobble,
        ...echo,
      }
    } else if (p.voice === 'spring') {
      change = { pitch: logBetween(800, 6000), resonance: between(0, 8), release: between(1, 3), ...echo }
    } else {
      change = {
        pitch: 440 * Math.pow(2, Math.round(between(-7, 7)) / 12),
        lfoDepth: Math.random() < 0.6 ? 0 : between(0.3, 3),
        reverse: Math.random() < 0.3,
        sweep: Math.random() < 0.7 ? 0 : pick([-12, 12]),
        sweepTime: logBetween(0.2, 1),
        ...wobble,
        ...echo,
      }
    }
    this.updatePatch(change)
  }

  /** Quick button: keep the current sound on it. */
  assignSlot(index: number, from?: { name: string; patch: Patch }): void {
    const slots = [...this.state.slots]
    const name = from?.name ?? this.state.preset ?? (this.state.patch.voice === 'sample' ? this.state.patch.sampleName : 'My sound')
    slots[index] = { name, patch: from?.patch ?? this.state.patch }
    this.set({ slots })
    this.save()
  }

  /** Quick button gets a preset by name (dragged onto it). */
  assignSlotPreset(index: number, name: string): void {
    const found = [...FACTORY, ...this.state.user].find((x) => x.name === renamed(name))
    if (found) this.assignSlot(index, found)
  }

  clearSlot(index: number): void {
    const slots = [...this.state.slots]
    slots[index] = null
    if (this.state.slotPlaying === index) this.release()
    this.set({ slots })
    this.save()
  }

  /** Ensaiar: hear the Dub Box only in the headphones, to try sounds without the crowd hearing. */
  setRehearse(on: boolean): void {
    this.set({ rehearse: on })
    const now = this.ctx.currentTime
    this.toMaster.gain.setTargetAtTime(on ? 0 : 1, now, 0.01)
    this.pflSend.gain.setTargetAtTime(on || this.state.pfl ? 1 : 0, now, 0.01)
  }

  setLevel(v: number): void {
    this.set({ level: clamp(v, 0, 1) })
    this.applyChannel()
    this.save()
  }

  setFilter(v: number): void {
    this.set({ filter: clamp(v, -1, 1) })
    this.applyChannel()
    this.save()
  }

  togglePfl(): void {
    this.set({ pfl: !this.state.pfl })
    this.pflSend.gain.setTargetAtTime(this.state.pfl || this.state.rehearse ? 1 : 0, this.ctx.currentTime, 0.01)
  }

  setMode(mode: DubBoxState['mode']): void {
    if (this.state.playing) this.release()
    this.set({ mode })
    this.save()
  }

  setSampler(on: boolean): void {
    this.set({ sampler: on })
    sampler.route(on ? this.input : null)
    this.save()
  }

  setFollowKey(followKey: boolean): void {
    this.set({ followKey })
    this.save()
  }

  private applyChannel(): void {
    const now = this.ctx.currentTime
    this.level.gain.setTargetAtTime(this.state.level, now, 0.01)
    // Same feel as the deck filter: left = low-pass, right = high-pass, centre = off.
    const v = this.state.filter
    const f = this.chFilter
    if (Math.abs(v) < 0.04) f.type = 'allpass'
    else if (v < 0) {
      f.type = 'lowpass'
      f.frequency.setTargetAtTime(20000 * Math.pow(150 / 20000, -v), now, 0.02)
    } else {
      f.type = 'highpass'
      f.frequency.setTargetAtTime(20 * Math.pow(8000 / 20, v), now, 0.02)
    }
    f.Q.value = Math.abs(v) < 0.04 ? 1 : 4
  }

  private applyEcho(p: Patch): void {
    const now = this.ctx.currentTime
    if (!this.state.throwing) this.echoSend.gain.setTargetAtTime(p.echo, now, 0.02)
    this.feedbackGain.gain.setTargetAtTime(p.feedback, now, 0.02)
    this.echoDark.frequency.setTargetAtTime(p.echoTone, now, 0.02)
    this.springGain.gain.setTargetAtTime(p.spring * 1.2, now, 0.02)
    this.retime(p)
  }

  private applyPatch(): void {
    const p = this.state.patch
    const now = this.ctx.currentTime
    this.applyEcho(p)
    const v = this.voice
    // Live changes reach the sound that is playing only when it is the sound being edited (not a quick button).
    if (!v || this.state.slotPlaying !== null || v.kind !== p.voice) return
    v.tone.frequency.setTargetAtTime(p.tone, now, 0.02)
    v.lfoGain.gain.setTargetAtTime(p.lfoDepth * 100, now, 0.02)
    if (v.lfo instanceof OscillatorNode) v.lfo.frequency.setTargetAtTime(p.lfoRate, now, 0.02)
    if (v.osc) {
      v.osc.type = p.wave
      v.frequency.setTargetAtTime(this.sirenPitch(p), now, 0.02)
    } else if (v.kind === 'sample') v.frequency.setTargetAtTime(p.pitch / 440, now, 0.02)
    else v.frequency.setTargetAtTime(p.pitch, now, 0.02)
    if (v.filter) v.filter.Q.setTargetAtTime(p.resonance, now, 0.02)
  }

  /** Echo time from the BPM of the deck that is playing (louder one wins), or 120 BPM. */
  private retime(p: Patch = this.voice?.patch ?? this.state.patch): void {
    const playing = decks.filter((d) => d.get().playing && d.get().bpm).sort((a, b) => b.get().volume - a.get().volume)
    const s = playing[0]?.get()
    const beat = s?.bpm ? 60 / (s.bpm * s.rate) : 0.5
    const time = clamp(beat * p.echoBeats, 0.03, 5.9)
    if (Math.abs(this.delay.delayTime.value - time) > time * 0.02) this.delay.delayTime.setTargetAtTime(time, this.ctx.currentTime, 0.03)
  }

  private save(): void {
    const { patch, user, level, filter, mode, followKey, preset } = this.state
    localStorage.setItem(
      LS,
      JSON.stringify({
        patch,
        user,
        level,
        filter,
        mode,
        followKey,
        preset,
        sampler: this.state.sampler,
        slots: this.state.slots,
        basePreset: this.state.basePreset,
      }),
    )
  }
}

export const dubBox = new DubBox()
