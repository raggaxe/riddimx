import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { decks, type Deck } from './deck'
import { isolator } from './isolator'
import { mic } from './mic'
import { choke } from './choke'

/**
 * Outboard gear in the rack, on the master: a tape echo with a spring reverb (fed by throws from
 * each deck) and the sound-system "weight" (sub boost and bass kill). Transitions live in moves.ts.
 *
 *   deck A / B (post fader) ─► throw ─► tape echo ─► spring ─► return ─┐
 *   masterGain ─► weight (sub shelf, kill) ─► compressor … ◄────────────┘ (return goes in before the fader)
 */

export const DIVISIONS = [
  { id: '1/8', beats: 0.5 },
  { id: '1/4', beats: 1 },
  { id: '3/8', beats: 1.5 },
  { id: '1/2', beats: 2 },
  { id: '3/4', beats: 3 },
] as const
export type Division = (typeof DIVISIONS)[number]['id']

export type RackUnitId = 'dub' | 'echo' | 'autodub'

export interface OutboardState {
  // tape echo
  division: Division
  feedback: number // 0..1.1 (above 1 it runs away, held in check by the tape saturation)
  tone: number // 0..1, dark to bright
  wobble: number // 0..1, tape wow and flutter
  spring: number // 0..1, spring reverb on the echo
  echoLevel: number // 0..1, return level
  throwing: { A: boolean; B: boolean }
  throwMode: 'bar' | 'hold' // THROW button: cuts the music into the echo until the next bar, or works while held
  send: { A: number; B: number } // 0..1, how much of each deck always feeds the echo (THROW = all of it)
  timeMode: 'sync' | 'manual' // echo time from the tempo of the music, or set by hand (TIME / TAP)
  manualTime: number // seconds, 0.05..2
  // weight
  weight: number // 0..1 → 0..+9 dB sub shelf
  weightHz: number // 40..120
  kill: boolean
  dropping: boolean
  // rack
  units: RackUnitId[]
  page: number // the rack page on show (0..RACK_PAGES-1): one row of units at a time
  pageOf: Partial<Record<RackUnitId, number>> // which page each unit sits on
}

/** The rack is one row tall; its units live on pages, flipped like the pages of a 19" rack. */
export const RACK_PAGES = ['Rack'] as const
/** Where each unit goes until the DJ moves it. */
const HOME_PAGE: Record<RackUnitId, number> = { dub: 0, autodub: 0, echo: 0 }

const LS = 'vx_outboard'
/** First run: what fits on one row of this screen (the tape echo joins on wide windows). */
const DEFAULT_UNITS = (): RackUnitId[] => ['dub', 'autodub']

function saved(): Partial<OutboardState> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

/** PESO frequency starts at 60 Hz (heard on any speaker); an older saved value is moved there once. */
function peso60(saved: number | undefined): number {
  try {
    if (!localStorage.getItem('vx_peso60')) {
      localStorage.setItem('vx_peso60', '1')
      return 60
    }
  } catch {
    /* not remembered */
  }
  return saved ?? 60
}

/** The automatic dub is mounted once by itself (so it is found); after that the DJ decides. */
function withAutoDub(units: RackUnitId[]): RackUnitId[] {
  try {
    if (localStorage.getItem('vx_autodub_mounted')) return units
    localStorage.setItem('vx_autodub_mounted', '1')
  } catch {
    return units
  }
  // Mounted at the end of the rack, and only when the window is wide enough to keep a single row.
  return units.includes('autodub') || window.innerWidth < 1400 ? units : [...units, 'autodub']
}

/** Live tempo for the echo: the playing deck's, else the first deck that knows its BPM, else 120. */
function liveBpm(): number {
  const playing = decks.map((d) => d.get()).find((d) => d.playing && d.bpm)
  const any = playing ?? decks.map((d) => d.get()).find((d) => d.bpm)
  return any?.bpm ? any.bpm * any.rate : 120
}

/** Tape saturation: soft, so a runaway echo grows warm instead of exploding. */
function tapeCurve(): Float32Array<ArrayBuffer> {
  const n = 2048
  const c = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    // Unity gain for quiet signals (slope 1 at zero): the tape only rounds off the loud peaks.
    // Scaled to its peak instead, quiet repeats came back 1.7× louder each pass and a normal REPETIR never died out.
    c[i] = Math.tanh(1.6 * x) / 1.6
  }
  return c
}

/** A spring tank's answer: a metallic, chirping decay (dispersive echoes) rather than a smooth room. */
function springImpulse(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.floor(rate * 2.6)
  const ir = ctx.createBuffer(2, length, rate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    const period = Math.floor(rate * (0.031 + c * 0.004)) // echoes running up and down the spring
    for (let i = 0; i < length; i++) {
      const t = i / rate
      const env = Math.exp(-t * 2.1)
      const chirp = Math.sin(2 * Math.PI * (900 + 2600 * ((i % period) / period)) * t) // the "boing"
      const pulse = i % period < rate * 0.004 ? 1 : 0.25
      d[i] = (Math.random() * 2 - 1) * env * 0.35 * pulse + chirp * env * 0.12 * pulse
    }
  }
  return ir
}

class Outboard extends Store<OutboardState> {
  private dampTimer = 0
  // tape echo
  private sends: Record<'A' | 'B', GainNode>
  private echoIn: GainNode
  private delay: DelayNode
  private tapeIn: WaveShaperNode
  private toneFilter: BiquadFilterNode
  private lowCut: BiquadFilterNode
  private feedbackGain: GainNode
  private wowDepth: GainNode
  private springSend: GainNode
  private springIn: GainNode
  private returnGain: GainNode
  // weight
  private weightIn: GainNode
  private shelf: BiquadFilterNode
  private killFilter: BiquadFilterNode
  private weightOut: GainNode

  constructor() {
    const s = saved()
    super({
      division: DIVISIONS.some((d) => d.id === s.division) ? (s.division as Division) : '3/8',
      feedback: clamp(s.feedback ?? 0.55, 0, 1.1),
      tone: clamp(s.tone ?? 0.45, 0, 1),
      wobble: clamp(s.wobble ?? 0.35, 0, 1),
      spring: clamp(s.spring ?? 0.4, 0, 1),
      echoLevel: clamp(s.echoLevel ?? 0.8, 0, 1),
      throwing: { A: false, B: false },
      throwMode: s.throwMode === 'hold' ? 'hold' : 'bar',
      send: { A: clamp(s.send?.A ?? 0, 0, 1), B: clamp(s.send?.B ?? 0, 0, 1) },
      timeMode: s.timeMode === 'manual' ? 'manual' : 'sync',
      manualTime: clamp(s.manualTime ?? 0.375, 0.05, 2),
      weight: clamp(s.weight ?? 0.3, 0, 1),
      weightHz: clamp(peso60(s.weightHz), 40, 120),
      kill: false,
      dropping: false,
      page: Math.min(RACK_PAGES.length - 1, Math.max(0, Number(s.page) || 0)),
      pageOf: s.pageOf && typeof s.pageOf === 'object' ? s.pageOf : {},
      units: withAutoDub(
        Array.isArray(s.units) && s.units.length
          ? s.units.filter((u): u is RackUnitId => typeof u === 'string' && u in HOME_PAGE && u !== 'echo')
          : DEFAULT_UNITS(),
      ),
    })
    const ctx = mixer.ctx

    // Tape echo: each deck's throw → saturation → delay ⟲ (tone, low cut, feedback, saturation)
    this.echoIn = ctx.createGain()
    this.sends = {
      A: ctx.createGain(),
      B: ctx.createGain(),
    }
    for (const d of decks) {
      const send = this.sends[d.name as 'A' | 'B']
      send.gain.value = this.state.send[d.name as 'A' | 'B']
      d.sendTap.connect(send)
      send.connect(this.echoIn)
    }
    this.tapeIn = ctx.createWaveShaper()
    this.tapeIn.curve = tapeCurve()
    this.delay = ctx.createDelay(4)
    this.toneFilter = ctx.createBiquadFilter()
    this.toneFilter.type = 'lowpass'
    this.lowCut = ctx.createBiquadFilter()
    this.lowCut.type = 'highpass'
    this.lowCut.frequency.value = 140
    this.feedbackGain = ctx.createGain()
    this.echoIn.connect(this.tapeIn)
    this.tapeIn.connect(this.delay)
    this.delay.connect(this.toneFilter)
    this.toneFilter.connect(this.lowCut)
    this.lowCut.connect(this.feedbackGain)
    this.feedbackGain.connect(this.tapeIn)

    // Wow and flutter: two slow wobbles on the delay time, like a worn tape.
    const wow = ctx.createOscillator()
    wow.frequency.value = 0.55
    const flutter = ctx.createOscillator()
    flutter.frequency.value = 6.3
    this.wowDepth = ctx.createGain()
    const flutterDepth = ctx.createGain()
    flutterDepth.gain.value = 0.12
    wow.connect(this.wowDepth)
    flutter.connect(flutterDepth).connect(this.wowDepth)
    this.wowDepth.connect(this.delay.delayTime)
    wow.start()
    flutter.start()

    // Return: the echo, plus its spring reverb.
    this.returnGain = ctx.createGain()
    this.springSend = ctx.createGain()
    this.springIn = ctx.createGain()
    const spring = ctx.createConvolver()
    spring.buffer = springImpulse(ctx)
    const springTone = ctx.createBiquadFilter()
    springTone.type = 'highpass'
    springTone.frequency.value = 300
    this.lowCut.connect(this.returnGain)
    this.lowCut.connect(this.springSend)
    this.springSend.connect(this.springIn)
    this.springIn.connect(springTone).connect(spring).connect(this.returnGain)
    this.returnGain.connect(mixer.masterGain)

    // Weight: sub shelf and a bass kill, between the master fader and the compressor.
    this.weightIn = ctx.createGain()
    this.shelf = ctx.createBiquadFilter()
    this.shelf.type = 'lowshelf'
    this.killFilter = ctx.createBiquadFilter()
    this.killFilter.type = 'highpass'
    this.killFilter.frequency.value = 10
    this.killFilter.Q.value = 0.7
    this.weightOut = ctx.createGain()
    this.weightIn.connect(this.shelf).connect(this.killFilter).connect(this.weightOut)
    // Master chain: fader ─► weight ─► isolator ─► duck (dips for the MC) ─► + mic ─► compressor …
    this.weightOut.connect(isolator.input)
    isolator.output.connect(mic.duck)
    mixer.insertPreDynamics(this.weightIn, mic.join)
    // The MC's voice has its echo and spring in the mic channel; the spring tank sounds the same.
    mic.useSpring(spring.buffer!)

    this.apply()
    // The echo follows the tempo of what is playing.
    window.setInterval(() => this.pushTempo(), 400)
  }

  private persist(): void {
    const { division, feedback, tone, wobble, spring, echoLevel, weight, weightHz, units, send, timeMode, manualTime, page, pageOf, throwMode } =
      this.state
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({
          division,
          feedback,
          tone,
          wobble,
          spring,
          echoLevel,
          weight,
          weightHz,
          units,
          send,
          timeMode,
          manualTime,
          throwMode,
          page,
          pageOf,
        }),
      )
    } catch {
      /* not remembered */
    }
  }

  /** Delay time for the chosen division at the live tempo, in seconds. */
  get echoTime(): number {
    if (this.state.timeMode === 'manual') return this.state.manualTime
    const beats = DIVISIONS.find((d) => d.id === this.state.division)?.beats ?? 1.5
    return Math.min(3.5, (60 / liveBpm()) * beats)
  }

  private pushTempo(): void {
    const now = mixer.ctx.currentTime
    this.delay.delayTime.setTargetAtTime(this.echoTime, now, 0.15) // glides, like changing tape speed
    mic.setTempo(60 / liveBpm(), this.echoTime)
  }

  private apply(): void {
    const s = this.state
    const now = mixer.ctx.currentTime
    const to = (p: AudioParam, v: number, tc = 0.03) => p.setTargetAtTime(v, now, tc)
    this.pushTempo()
    to(this.feedbackGain.gain, s.feedback)
    to(this.toneFilter.frequency, 700 * Math.pow(9000 / 700, s.tone))
    to(this.wowDepth.gain, 0.0004 + s.wobble * 0.0035)
    to(this.springSend.gain, s.spring * 1.4)
    to(this.returnGain.gain, s.echoLevel)
    // PESO lives on the mixer now: always in the chain (0 = flat).
    to(this.shelf.frequency, s.weightHz)
    to(this.shelf.gain, s.weight * 9)
    to(this.killFilter.frequency, s.kill ? 220 : 10, 0.012)
  }

  update(change: Partial<OutboardState>): void {
    this.set(change)
    this.apply()
    this.persist()
  }

  // ───────────────────────── tape echo ─────────────────────────

  private barThrow: Record<'A' | 'B', number[]> = { A: [], B: [] } // timers of a THROW to the bar

  setThrowMode(throwMode: 'bar' | 'hold'): void {
    this.set({ throwMode })
    this.persist()
  }

  /**
   * The THROW button (screen, controller, phone). In 'bar' mode one press throws to the bar: the
   * music drops out, its last beat rings in the echo, and the music is back on the one of the next
   * bar. Pressed again before that: back at once. In 'hold' mode it throws while held.
   */
  throwPress(deck: 'A' | 'B', down: boolean): void {
    if (this.state.throwMode === 'hold') return this.throw(deck, down)
    if (!down) return
    if (this.barThrow[deck].length) return this.endBarThrow(deck)
    const d = decks.find((x) => x.name === deck)
    const bar = d?.nextBar()
    mixer.resume()
    this.throw(deck, true)
    if (!d || !bar) {
      // No grid or not playing: a short throw, the music never stops.
      this.barThrow[deck] = [window.setTimeout(() => this.endBarThrow(deck), 500)]
      return
    }
    d.throwMute(true)
    // A beat of music goes into the echo; after that nothing more, so it repeats only what was thrown.
    const catchFor = Math.min(bar.beat, bar.wait)
    const sendClose = window.setTimeout(() => this.sends[deck].gain.setTargetAtTime(0, mixer.ctx.currentTime, 0.01), catchFor * 1000)
    // A bar that starts in under a beat leaves no room for the echo: wait for the one after it.
    const back = bar.wait < bar.beat ? bar.wait + bar.beat * 4 : bar.wait
    d.throwMute(false, mixer.ctx.currentTime + back)
    this.barThrow[deck] = [sendClose, window.setTimeout(() => this.endBarThrow(deck, false), back * 1000)]
  }

  private endBarThrow(deck: 'A' | 'B', now = true): void {
    for (const t of this.barThrow[deck]) window.clearTimeout(t)
    this.barThrow[deck] = []
    if (now) decks.find((x) => x.name === deck)?.throwMute(false)
    this.throw(deck, false)
  }

  /** Throw a deck into the echo (held); let go and the repeats carry on by themselves. */
  throw(deck: 'A' | 'B', on: boolean): void {
    mixer.resume()
    const send = this.sends[deck].gain
    send.setTargetAtTime(on ? 1 : this.state.send[deck], mixer.ctx.currentTime, on ? 0.005 : 0.02)
    this.set({ throwing: { ...this.state.throwing, [deck]: on } })
  }

  /**
   * Closes the echo tail: the repeats fade out over `seconds` (feedback pulled down), then REPETIR is
   * back where the DJ left it. Used at the end of ECO OUT so the old tune does not keep echoing.
   */
  /** PANIC: both throws let go, the drop undone, the tape echo stops repeating. */
  panic(): void {
    for (const d of ['A', 'B'] as const) {
      if (this.barThrow[d].length) this.endBarThrow(d)
      else if (this.state.throwing[d]) this.throw(d, false)
    }
    this.setKill(false)
    if (this.state.dropping) this.set({ dropping: false })
    window.clearTimeout(this.dampTimer)
    choke(this.feedbackGain.gain, mixer.ctx)
  }

  damp(seconds: number): void {
    const now = mixer.ctx.currentTime
    const g = this.feedbackGain.gain
    g.cancelScheduledValues(now)
    g.setValueAtTime(g.value, now)
    g.linearRampToValueAtTime(0.15, now + seconds)
    window.clearTimeout(this.dampTimer)
    this.dampTimer = window.setTimeout(
      () => {
        this.feedbackGain.gain.cancelScheduledValues(mixer.ctx.currentTime)
        this.feedbackGain.gain.setTargetAtTime(this.state.feedback, mixer.ctx.currentTime, 0.3)
      },
      (seconds + 2.5) * 1000,
    )
  }

  /** Kick the spring tank: the crash a dub engineer gets by hitting the reverb. */
  crash(): void {
    mixer.resume()
    const ctx = mixer.ctx
    const n = Math.floor(ctx.sampleRate * 0.09)
    const burst = ctx.createBuffer(1, n, ctx.sampleRate)
    const d = burst.getChannelData(0)
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2)
    const src = ctx.createBufferSource()
    src.buffer = burst
    const level = ctx.createGain()
    level.gain.value = 1.6
    src.connect(level).connect(this.springIn)
    src.start()
  }

  /** Continuous send of a deck into the echo (the SEND knob); THROW still sends everything while held. */
  setSend(deck: 'A' | 'B', v: number): void {
    const send = { ...this.state.send, [deck]: clamp(v, 0, 1) }
    this.update({ send })
    if (!this.state.throwing[deck]) this.sends[deck].gain.setTargetAtTime(send[deck], mixer.ctx.currentTime, 0.02)
  }

  /** TIME by hand: the echo stops following the music's tempo. */
  setManualTime(seconds: number): void {
    this.update({ timeMode: 'manual', manualTime: clamp(seconds, 0.05, 2) })
  }

  /** Back to the tempo of the music (a division chosen in the menu does this too). */
  syncTime(): void {
    this.update({ timeMode: 'sync' })
  }

  private taps: number[] = []
  /** TAP: two or more taps set the echo time to their average spacing. */
  tap(): void {
    const now = performance.now()
    this.taps = [...this.taps.filter((t) => now - t < 2500), now].slice(-5)
    if (this.taps.length < 2) return
    const gaps = this.taps.slice(1).map((t, i) => t - this.taps[i])
    this.setManualTime(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000)
  }

  // ───────────────────────── weight ─────────────────────────

  setKill(on: boolean): void {
    this.update({ kill: on })
  }

  /** Bass out for one bar, back in exactly on the next downbeat: the drop. */
  drop(): void {
    if (this.state.dropping) return
    const live = liveDeck()
    const beat = live?.nextBeat()
    const beatLen = beat?.beat ?? 60 / liveBpm()
    const start = beat ? beat.wait : 0
    this.set({ dropping: true })
    window.setTimeout(() => this.setKill(true), start * 1000)
    window.setTimeout(
      () => {
        this.setKill(false)
        this.set({ dropping: false })
      },
      (start + beatLen * 4) * 1000,
    )
  }

  /** The page a unit sits on. */
  pageFor(unit: RackUnitId): number {
    return Math.min(RACK_PAGES.length - 1, this.state.pageOf[unit] ?? HOME_PAGE[unit] ?? 0)
  }

  /** Shows another page of the rack. */
  setPage(page: number): void {
    const n = RACK_PAGES.length
    this.update({ page: ((page % n) + n) % n })
  }

  /** Puts a unit on a page, before another unit (or at the end of the page). */
  placeUnit(unit: RackUnitId, page: number, before: RackUnitId | null): void {
    const rest = this.state.units.filter((u) => u !== unit)
    const at = before ? rest.indexOf(before) : rest.length
    this.update({
      units: [...rest.slice(0, at < 0 ? rest.length : at), unit, ...rest.slice(at < 0 ? rest.length : at)],
      pageOf: { ...this.state.pageOf, [unit]: page },
    })
  }

  setUnits(units: RackUnitId[]): void {
    this.update({ units })
  }
}

/** The deck the crowd hears now: playing and loudest through its fader and the crossfader. */
export function liveDeck(): Deck | null {
  const heard = decks
    .map((d, i) => ({ d, level: d.get().playing ? d.get().volume * mixer.sideGain(i as 0 | 1) : 0 }))
    .sort((a, b) => b.level - a.level)
  return heard[0].level > 0 ? heard[0].d : null
}

export const outboard = new Outboard()
