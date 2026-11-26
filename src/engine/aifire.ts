import { Store } from '../store'
import type { Deck } from './deck'
import { dubAi } from './dubai'
import { FACTORY, dubBox, type Patch } from './dubbox'
import { mixer } from './mixer'
import { liveDeck } from './outboard'

/**
 * AI FIRE: one press arms a Dub Box shot for the next good moment of the deck on air, the way a selector
 * picks the spot for the siren. It listens with the AI DUB ears (the stems) and counts on the beat grid:
 *
 *   phrase end   the last two beats before a 4-bar phrase turns over: a siren, its LFO on the tempo,
 *                cut on the one (a 16-bar turn gets a whoosh rising into it)
 *   vocal gap    the singer stops for a breath, the riddim keeps going: a pew or a lickshot on the beat
 *   break        the kick drops out: a laser on the beat
 *
 * It fires once and disarms. Pressed again before (or while it sounds): cancelled. The FIRE key's own
 * sound is never changed, and the echo goes back to how that sound has it once the shot's tail is gone.
 */

type Moment = 'phrase' | 'turn16' | 'gap' | 'break'

interface Plan {
  moment: Moment
  sound: string // a FACTORY name
  at: number // beat (on the deck's grid) where it fires
  hold: number // beats it sounds
  bar: number // the bar it lands in, to say so
}

export interface AiFireState {
  armed: boolean
  firing: boolean
  /** Beats until it fires, while armed and a deck is playing. */
  left: number | null
  /** One line for the screen: what and when ("Siren · end of bar 16"). */
  say: string
}

const WHY: Record<Moment, string> = { phrase: 'phrase end', turn16: 'into the 16', gap: 'vocal gap', break: 'break' }
const SHORT: Record<string, string> = { 'Classic siren': 'Siren', 'Pew tom': 'Pew', Lickshot: 'Lickshot', Laser: 'Laser', Whoosh: 'Whoosh', Alarm: 'Alarm' }

class AiFire extends Store<AiFireState> {
  private timer = 0
  private plan: Plan | null = null
  private stop: (() => void) | null = null
  private pending = 0
  private turn = 0 // alternates the siren between two flavours, so it doesn't always sound the same
  // The kick's pulse: when it last hit and how far apart its hits usually are (a one-drop hits once a
  // bar, a steppers every beat). A break is the kick missing well past its usual gap.
  private lastHit = 0
  private hitGap = 0
  private kickWas = false

  constructor() {
    super({ armed: false, firing: false, left: null, say: '' })
  }

  /** The AI FIRE key: arm; pressed again (armed or sounding): cancel, the patch's echo back. */
  toggle(): void {
    if (this.state.armed || this.state.firing) return this.cancel()
    this.plan = null
    this.lastHit = this.hitGap = 0
    this.set({ armed: true, firing: false, left: null, say: 'Listening…' })
    window.clearInterval(this.timer)
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  cancel(): void {
    window.clearInterval(this.timer)
    window.clearTimeout(this.pending)
    this.timer = 0
    this.plan = null
    this.stop?.()
    this.stop = null
    this.set({ armed: false, firing: false, left: null, say: '' })
  }

  /** The next good moment from where the deck is now. */
  private choose(deck: Deck, beat: number, phase: number): Plan {
    const ears = dubAi.listen(deck)
    const now = mixer.ctx.currentTime
    const { len } = dubAi.grid(deck)
    const pos = beat + phase
    const voice = ears.vocal
    const sinceHit = now - this.lastHit
    const kickGone = this.hitGap > 0 && !ears.kick.on && sinceHit > Math.max(this.hitGap * 1.75, len * 1.5) && sinceHit < len * 8
    const gap = !voice.on && now - voice.since > len * 0.75 && (ears.instr.on || ears.kick.on || now - ears.instr.since < len * 1.1)
    // Right now: a break or a breath, on the next beat.
    if (kickGone) return { moment: 'break', sound: 'Laser', at: beat + 1, hold: 0.1, bar: Math.floor((beat + 1) / 4) + 1 }
    if (gap) {
      const sound = (beat & 1) === 0 ? 'Pew tom' : 'Lickshot'
      return { moment: 'gap', sound, at: beat + 1, hold: 0.1, bar: Math.floor((beat + 1) / 4) + 1 }
    }
    // Otherwise the end of the next 4-bar phrase (at least 3 beats away): the siren on its last 2 beats,
    // or the whoosh on its last bar when the phrase is a 16-bar turn.
    let one = Math.ceil(pos / 16) * 16
    if (one - pos < 3) one += 16
    if (one % 64 === 0 && one - 4 - pos >= 1) return { moment: 'turn16', sound: 'Whoosh', at: one - 4, hold: 3.6, bar: one / 4 }
    this.turn++
    return { moment: 'phrase', sound: this.turn % 3 === 0 ? 'Alarm' : 'Classic siren', at: one - 2, hold: 1.85, bar: one / 4 }
  }

  /** The shot's sound: the factory one, its LFO and echo on the tempo of the deck. */
  private patchFor(plan: Plan, len: number): Patch {
    const p = { ...FACTORY.find((f) => f.name === plan.sound)!.patch }
    const bps = 1 / len
    if (plan.sound === 'Classic siren') Object.assign(p, { lfoRate: bps * 2, echo: 0.5, echoBeats: 0.75, feedback: 0.5 })
    if (plan.sound === 'Alarm') Object.assign(p, { lfoRate: bps * 4, echo: 0.45, echoBeats: 0.5 })
    if (plan.sound === 'Whoosh') Object.assign(p, { sweepTime: Math.min(4, len * 3.6), echoBeats: 1 })
    return p
  }

  private tick(): void {
    const deck = liveDeck()
    if (!deck) {
      if (this.state.say !== 'Waiting for a deck to play') this.set({ left: null, say: 'Waiting for a deck to play' })
      return
    }
    const { beat, phase, len } = dubAi.grid(deck)
    const pos = beat + phase
    const kick = dubAi.listen(deck).kick
    if (kick.on && !this.kickWas) {
      const now = mixer.ctx.currentTime
      const d = now - this.lastHit
      if (this.lastHit && d > len * 0.4 && d < len * 8) this.hitGap = this.hitGap ? this.hitGap * 0.7 + d * 0.3 : d
      this.lastHit = now
    }
    this.kickWas = kick.on
    // A stale plan (the DJ jumped in the track, or the moment passed by more than a beat): plan again.
    if (!this.plan || pos > this.plan.at + 1 || this.plan.at - pos > 72) this.plan = this.choose(deck, beat, phase)
    const plan = this.plan
    // A phrase plan far off gives way to a breath of the singer that comes first.
    if ((plan.moment === 'phrase' || plan.moment === 'turn16') && plan.at - pos > 6) {
      const better = this.choose(deck, beat, phase)
      if (better.moment === 'gap' || better.moment === 'break') this.plan = better
    }
    const p = this.plan!
    const left = p.at - pos
    const say = (SHORT[p.sound] ?? p.sound) + ' · ' + (p.moment === 'phrase' || p.moment === 'turn16' ? 'end of bar ' + p.bar : WHY[p.moment])
    const beatsLeft = Math.max(0, Math.ceil(left))
    if (beatsLeft !== this.state.left || say !== this.state.say) this.set({ left: beatsLeft, say })
    // On time: the last few ms by a timer, so it lands on the beat and not on the next 25 ms tick.
    const ms = left * len * 1000
    if (ms < 40 && !this.pending) {
      window.clearInterval(this.timer)
      this.timer = 0
      this.pending = window.setTimeout(() => this.fire(p, len), Math.max(0, ms))
    }
  }

  private fire(plan: Plan, len: number): void {
    this.pending = 0
    const hold = plan.hold * len
    this.stop = dubBox.aiShot(this.patchFor(plan, len), hold)
    this.plan = null
    this.set({ armed: false, firing: true, left: null, say: (SHORT[plan.sound] ?? plan.sound) + ' · ' + WHY[plan.moment] })
    window.setTimeout(
      () => {
        if (!this.state.firing) return
        this.stop = null
        this.set({ firing: false, say: '' })
      },
      Math.max(hold, 0.4) * 1000,
    )
  }
}

export const aiFire = new AiFire()

import.meta.hot?.dispose(() => aiFire.cancel())
