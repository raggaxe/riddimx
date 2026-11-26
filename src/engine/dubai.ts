import { Store } from '../store'
import { decks, type Deck } from './deck'
import { mixer } from './mixer'
import { liveDeck } from './outboard'
import { plugin } from './plugin'
import type { Stem } from './stems'

/**
 * AI dub: pads that ride the AUX sends live, the way a dub engineer rides the desk, by LISTENING to the
 * stems of the deck on air (separated by the AI, or by the filters when the track has no AI stems) and
 * moving on its beat grid.
 *
 *   THROW   the singer ends a line: the tail of the last word goes into the echo (AUX 1) and repeats out
 *   SKANK   the voice is out: the off-beat chops of the instruments go into the echo, bar by bar
 *   SPRING  the drums drop out, or a phrase turns over: the spring (AUX 2) gets a hit
 *   SWELL   the last bar of every 8: echo and spring rise on everything, and cut on the one
 *   AUTO    all four, at a measured pace
 *
 * Each pad is on/off; nothing changes the knobs: the moves sit on top of them and go back to them.
 * AUX 1 should be an echo and AUX 2 a spring or reverb: turning a pad on sets that up if it isn't.
 */

export type DubPad = 'throw' | 'skank' | 'spring' | 'swell' | 'auto'

export const DUB_PADS: { id: DubPad; label: string; hint: string }[] = [
  { id: 'throw', label: 'THROW', hint: 'Listens to the voice: when a line ends, its last word goes into the echo' },
  { id: 'skank', label: 'SKANK', hint: 'While nobody sings: the off-beat chops of the instruments into the echo' },
  { id: 'spring', label: 'SPRING', hint: 'Hits the spring when the drums drop out or a phrase turns over' },
  { id: 'swell', label: 'SWELL', hint: 'Last bar of every 8: echo and spring swell up, cut on the one' },
  { id: 'auto', label: 'AUTO', hint: 'All of it, by itself, at a measured pace: the AI rides the desk' },
]

export interface DubAiState {
  on: Record<DubPad, boolean>
  /** The move just made, for the screen ("Throw · voice"), or null. */
  doing: string | null
  /** What turning a pad on changed in the AUX setup, said once. */
  note: string | null
  /** The deck being listened to. */
  deck: 'A' | 'B' | null
}

const LISTEN: Stem[] = ['vocal', 'instr', 'kick', 'hat']
const ECHO_FX = ['dubecho', 'delay']
const TANK_FX = ['spring', 'plate', 'reverb']

/** One stem's loudness over time: fast level, slow peak, and whether it is sounding now. */
export class Follower {
  level = 0
  peak = 0.02
  on = false
  since = 0 // when `on` last changed (s, audio clock)
  runPeak = 0 // loudest moment of the current run
}

class DubAi extends Store<DubAiState> {
  private timer = 0
  private analysers = new Map<Deck, Record<string, AnalyserNode>>()
  private follow = new Map<Deck, Record<string, Follower>>()
  private buf = new Float32Array(new ArrayBuffer(1024 * 4))
  private heardAt = new Map<Deck, number>()
  private lastBeat = -1
  private lastThrow = -99
  private lastSpring = -99
  private lastSwell = -1
  private clockStart = performance.now()

  constructor() {
    super({ on: { throw: false, skank: false, spring: false, swell: false, auto: false }, doing: null, note: null, deck: null })
  }

  toggle(pad: DubPad): void {
    const on = { ...this.state.on, [pad]: !this.state.on[pad] }
    const any = Object.values(on).some(Boolean)
    this.set({ on })
    if (any && !this.timer) this.start()
    if (!any) this.stop()
  }

  private active(pad: Exclude<DubPad, 'auto'>): boolean {
    return this.state.on[pad] || this.state.on.auto
  }

  private start(): void {
    // AUX 1 must echo and AUX 2 ring: set them up if they don't (and say so).
    const aux = plugin.get().aux
    const changed: string[] = []
    if (!ECHO_FX.includes(aux[0].fx)) {
      plugin.updateAux(0, { fx: 'dubecho', a: 0.2, b: 0.55, ret: Math.max(aux[0].ret, 0.75) })
      changed.push('AUX 1 → DUB ECHO')
    }
    if (!TANK_FX.includes(aux[1].fx)) {
      plugin.updateAux(1, { fx: 'spring', a: 0.45, b: 0.45, ret: Math.max(aux[1].ret, 0.7) })
      changed.push('AUX 2 → SPRING')
    }
    this.set({ note: changed.length ? changed.join(' · ') : null })
    this.lastBeat = -1
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  private stop(): void {
    window.clearInterval(this.timer)
    this.timer = 0
    plugin.settle() // every send back to its knob
    this.set({ doing: null, deck: null, note: null })
  }

  /**
   * Analysers on the stems of one deck, made the first time it is listened to. Shared with AI FIRE: two
   * callers in the same few ms get the same reading (the followers move once).
   */
  listen(deck: Deck): Record<string, Follower> {
    if (!this.analysers.has(deck)) {
      const an: Record<string, AnalyserNode> = {}
      const fo: Record<string, Follower> = {}
      for (const stem of LISTEN) {
        const a = mixer.ctx.createAnalyser()
        a.fftSize = 1024
        // One channel, not L+R: the filter-made INSTR stem is the sides (L = +side, R = −side), which a
        // mono sum would cancel to silence.
        a.channelCount = 1
        a.channelCountMode = 'explicit'
        a.channelInterpretation = 'discrete'
        deck.stemTap[stem].connect(a)
        an[stem] = a
        fo[stem] = new Follower()
      }
      this.analysers.set(deck, an)
      this.follow.set(deck, fo)
    }
    const an = this.analysers.get(deck)!
    const fo = this.follow.get(deck)!
    if (performance.now() - (this.heardAt.get(deck) ?? 0) < 15) return fo
    this.heardAt.set(deck, performance.now())
    const now = mixer.ctx.currentTime
    for (const stem of LISTEN) {
      an[stem].getFloatTimeDomainData(this.buf)
      let sum = 0
      for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i]
      const rms = Math.sqrt(sum / this.buf.length)
      const f = fo[stem]
      f.level += (rms - f.level) * 0.5
      f.peak = Math.max(f.level, f.peak * 0.9995, 0.004) // slow memory of how loud this stem gets
      // Sounding: above a quarter of its usual peak (with a little hysteresis).
      const on = f.on ? f.level > f.peak * 0.16 : f.level > f.peak * 0.25
      if (on !== f.on) {
        f.on = on
        f.since = now
        f.runPeak = 0
      }
      if (on) f.runPeak = Math.max(f.runPeak, f.level)
    }
    return fo
  }

  /** Where the deck is in its beat grid: beat number, position inside the beat (0..1), seconds per beat. */
  grid(deck: Deck): { beat: number; phase: number; len: number } {
    const s = deck.get()
    const len = s.bpm ? 60 / (s.bpm * s.rate) : 0.5
    let beats: number
    // Counted from the one of a bar when the deck knows it, so bar 8 of a phrase is really the eighth.
    const ref = s.barAt ?? s.anchor
    if (s.bpm && ref !== null) beats = (deck.getPosition() - ref) / (60 / s.bpm)
    else beats = (performance.now() - this.clockStart) / 1000 / len
    return { beat: Math.floor(beats), phase: beats - Math.floor(beats), len }
  }

  private flash(doing: string, seconds: number): void {
    this.set({ doing })
    window.setTimeout(() => this.state.doing === doing && this.set({ doing: null }), seconds * 1000)
  }

  private tick(): void {
    const deck = liveDeck()
    const name = (deck?.name ?? null) as 'A' | 'B' | null
    if (name !== this.state.deck) this.set({ deck: name })
    if (!deck || !name) return
    const fo = this.listen(deck)
    const { beat, phase, len } = this.grid(deck)
    const now = mixer.ctx.currentTime
    const inBar = ((beat % 4) + 4) % 4
    const bar = Math.floor(beat / 4)
    const barIn8 = ((bar % 8) + 8) % 8
    const auto = this.state.on.auto
    const voice = fo.vocal
    const newBeat = beat !== this.lastBeat
    this.lastBeat = beat

    // THROW: a line has been sung for at least a beat and its level falls to half: that is the last
    // word dying away; catch its tail in the echo (at most once per 2 bars; AUTO prefers bar ends).
    if (this.active('throw') && voice.on && now - voice.since > len && voice.level < voice.runPeak * 0.5) {
      const gap = auto ? 8 : 6
      if (beat - this.lastThrow >= gap && (!auto || inBar >= 2)) {
        this.lastThrow = beat
        plugin.ride(0, name, 'vocal', 1, { attack: 0.02, hold: len * 0.6, release: 0.25 })
        this.flash('Throw · voice', len * 2)
      }
    }

    if (!newBeat) return

    // SKANK: nobody has sung for 2 beats and the instruments play: their off-beat goes into the echo,
    // every bar (every other bar under AUTO).
    // (The chops sound between beats, so "playing" means heard within the last beat.)
    const instrHeard = fo.instr.on || now - fo.instr.since < len * 1.1
    if (this.active('skank') && !voice.on && now - voice.since > len * 2 && instrHeard && (inBar === 1 || inBar === 3)) {
      if (!auto || bar % 2 === 0) {
        plugin.ride(0, name, 'instr', 0.85, { at: Math.max(0, 0.5 - phase) * len, attack: 0.01, hold: len * 0.22, release: 0.08 })
        if (inBar === 1) this.flash('Skank · echo', len * 2)
      }
    }

    // SPRING: the kick has just dropped out (a break), or a phrase turns over: hit the tank.
    const kickGone = !fo.kick.on && now - fo.kick.since < len * 1.2 && now - fo.kick.since > len * 0.4
    const turn = barIn8 === 7 && inBar === 3
    if (this.active('spring') && (kickGone || (turn && (!auto || Math.random() < 0.6))) && beat - this.lastSpring >= 8) {
      this.lastSpring = beat
      plugin.ride(1, name, 'hat', 1, { attack: 0.005, hold: len * 0.15, release: 0.1 })
      plugin.ride(1, name, 'instr', 0.7, { attack: 0.005, hold: len * 0.15, release: 0.1 })
      this.flash('Spring hit', len * 2)
    }

    // SWELL: the last bar of every 8 rises into the echo and the spring, and cuts on the one.
    if (this.active('swell') && barIn8 === 7 && inBar === 0 && this.lastSwell !== bar && (!auto || bar % 16 === 15)) {
      this.lastSwell = bar
      const bar4 = len * 4
      for (const stem of ['vocal', 'instr', 'hat'] as Stem[]) {
        plugin.ride(0, name, stem, 0.8, { attack: bar4 * 0.9, hold: bar4 * 0.1 - 0.02, release: 0.03 })
      }
      plugin.ride(1, name, 'instr', 0.6, { attack: bar4 * 0.9, hold: bar4 * 0.1 - 0.02, release: 0.03 })
      this.flash('Swell', bar4)
    }
  }
}

export const dubAi = new DubAi()

// Editing this file while the app runs: the old one lets go of the sends.
import.meta.hot?.dispose(() => {
  if (Object.values(dubAi.get().on).some(Boolean)) for (const p of DUB_PADS) dubAi.get().on[p.id] && dubAi.toggle(p.id)
})
