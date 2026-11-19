import { Store } from '../store'
import { mixer } from './mixer'
import { decks, type Deck } from './deck'
import { liveDeck, outboard } from './outboard'

/**
 * Transitions: one button takes the dance from the deck playing to the other one, on the beat,
 * and leaves everything tidy afterwards (outgoing deck stopped with its fader, EQ, filter and pitch
 * put back; crossfader on the new side). A running move can be cancelled, which puts things back too.
 */

export type Move = 'cut' | 'echoOut' | 'bassSwap' | 'sweep' | 'tapeStop' | 'drop'
export type Quant = 'beat' | 'bar'
export type Direction = 'auto' | 'AB' | 'BA'

export interface MovesState {
  running: Move | null
  from: 'A' | 'B' | null // the outgoing deck of the running move (the arrow stays put while it runs)
  waiting: boolean // armed, waiting for the beat / bar to start
  startedAt: number // performance.now() when the move really began
  length: number // seconds the move lasts once it has begun
  beats: 4 | 8 | 16 // length of the long moves
  quant: Quant
  direction: Direction
}

const LS = 'vx_moves'

function saved(): Partial<MovesState> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

/** Which way a move goes: chosen by hand, or from the deck the crowd hears now to the other one. */
export function route(direction: Direction): { from: Deck; to: Deck } | null {
  if (direction === 'AB') return { from: decks[0], to: decks[1] }
  if (direction === 'BA') return { from: decks[1], to: decks[0] }
  const from = liveDeck()
  return from ? { from, to: decks.find((d) => d !== from)! } : null
}

/** Seconds until the next beat (or bar: 4 beats from the grid's first beat), and one beat's length. */
function nextStart(deck: Deck, quant: Quant): { wait: number; beat: number } {
  const next = deck.nextBeat()
  const s = deck.get()
  const fallback = s.bpm ? 60 / (s.bpm * s.rate) : 0.5
  if (!next) return { wait: 0, beat: fallback }
  if (quant === 'beat' || s.anchor === null || !s.bpm) return next
  const beatTrack = 60 / s.bpm
  const index = Math.round((deck.getPosition() + next.wait * s.rate - s.anchor) / beatTrack) // beat number of the next beat
  const toBar = (4 - (((index % 4) + 4) % 4)) % 4
  return { wait: next.wait + toBar * next.beat, beat: next.beat }
}

interface Snapshot {
  volume: number
  low: number
  filter: number
}

export const MOVES: Record<Move, { label: string; hint: string; long: boolean }> = {
  cut: { label: 'NO UM', hint: 'Corte seco no primeiro tempo: a outra entra do cue e esta para', long: false },
  echoOut: { label: 'ECO OUT', hint: 'A que sai vai para o eco de fita e fecha; a outra entra no compasso seguinte', long: false },
  bassSwap: {
    label: 'TROCA GRAVE',
    hint: 'As duas tocam juntas; a meio o grave passa de uma para a outra, depois a que sai desaparece',
    long: true,
  },
  sweep: { label: 'VARREDURA', hint: 'Filtro abre na que sai enquanto o crossfader passa para a outra', long: true },
  tapeStop: { label: 'PARAGEM', hint: 'A que sai abranda até parar como fita; a outra entra quando pára', long: false },
  drop: {
    label: 'DROP E ENTRA',
    hint: 'Tira o grave um compasso e volta no um; se a outra estiver pronta, entra nesse momento',
    long: false,
  },
}

class Moves extends Store<MovesState> {
  private timers: number[] = []
  private token = 0
  private undo: (() => void) | null = null
  private watchdog = 0

  constructor() {
    const s = saved()
    super({
      running: null,
      from: null,
      waiting: false,
      startedAt: 0,
      length: 0,
      beats: s.beats === 4 || s.beats === 16 ? s.beats : 8,
      quant: s.quant === 'beat' ? 'beat' : 'bar',
      direction: s.direction === 'AB' || s.direction === 'BA' ? s.direction : 'auto',
    })
  }

  settings(change: Partial<Pick<MovesState, 'beats' | 'quant' | 'direction'>>): void {
    this.set(change)
    const { beats, quant, direction } = this.state
    try {
      localStorage.setItem(LS, JSON.stringify({ beats, quant, direction }))
    } catch {
      /* not remembered */
    }
  }

  private later(seconds: number, run: () => void): void {
    const token = this.token
    this.timers.push(window.setTimeout(() => token === this.token && run(), Math.max(0, seconds) * 1000))
  }

  /** Runs f(t) for t from 0 to 1 over `seconds`, unless the move is cancelled. */
  private ramp(seconds: number, f: (t: number) => void): void {
    const token = this.token
    const start = performance.now()
    const step = () => {
      if (token !== this.token) return
      const t = Math.min(1, (performance.now() - start) / (seconds * 1000))
      f(t)
      if (t < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  /** Start the incoming deck at its cue / current place, fader up, if it is loaded and stopped. */
  private bringIn(to: Deck, volume = Math.max(0.8, to.get().volume)): void {
    const s = to.get()
    if (s.kind === 'none') return
    if (s.volume < 0.05) to.setVolume(volume)
    if (!s.playing) to.play()
  }

  /** The outgoing deck stops and gets its controls back, ready for the next track. */
  private tidy(from: Deck, snap: Snapshot): void {
    if (from.get().playing) from.pause()
    from.setBend(1)
    from.setVolume(snap.volume)
    from.setEq('low', snap.low)
    from.setFilter(snap.filter)
  }

  /** Crossfader fully on a deck's side. */
  private xfTo(deck: Deck, seconds = 0): void {
    const side = deck === decks[0] ? 0 : 1
    if (seconds > 0) mixer.autoFade(side, seconds)
    else mixer.setCrossfader(side)
  }

  run(move: Move): void {
    if (this.state.running === move) return this.cancel()
    if (this.state.running) return
    const way = route(this.state.direction)
    if (!way) return
    // The moves fade with the crossfader: switched off (THRU) they would do nothing, so it comes back on.
    if (mixer.get().xfCurve === 'thru') mixer.setCrossfaderCurve('smooth')
    const { from, to } = way
    const fs = from.get()
    const snap: Snapshot = { volume: fs.volume, low: fs.low, filter: fs.filter }
    const xf = mixer.get().crossfader
    const ts = to.get()
    const toBefore = { playing: ts.playing, volume: ts.volume, low: ts.low }
    const token = ++this.token
    // Cancel = everything as it was before the button was pressed.
    this.undo = () => {
      outboard.throw(from.name as 'A' | 'B', false)
      outboard.setKill(false)
      from.setBend(1)
      from.setVolume(snap.volume)
      from.setEq('low', snap.low)
      from.setFilter(snap.filter)
      to.setEq('low', toBefore.low)
      to.setVolume(toBefore.volume)
      if (!toBefore.playing && to.get().playing) to.pause()
      if (!from.get().playing && fs.playing) from.play()
      mixer.stopAutoFade()
      mixer.setCrossfader(xf)
    }
    const start = nextStart(from, move === 'cut' ? 'bar' : this.state.quant) // a cut is always on the one
    // A tempo read wrong (or a deck without one) must never stretch a move without end:
    // a beat between 0.25 s and 1.5 s, and the start at most one bar away.
    const beat = Number.isFinite(start.beat) ? Math.min(1.5, Math.max(0.25, start.beat)) : 0.5
    const wait = Number.isFinite(start.wait) ? Math.min(beat * 4, Math.max(0, start.wait)) : 0
    const long = beat * this.state.beats
    const lengths: Record<Move, number> = {
      cut: beat,
      echoOut: beat * 4,
      bassSwap: long,
      sweep: long,
      tapeStop: Math.max(0.8, beat * 2) + beat,
      drop: beat * 4,
    }
    this.set({
      running: move,
      from: from.name as 'A' | 'B',
      waiting: wait > 0.05,
      startedAt: performance.now() + wait * 1000,
      length: lengths[move],
    })
    const finish = () => {
      if (token !== this.token) return
      window.clearTimeout(this.watchdog)
      this.timers = []
      this.undo = null
      this.set({ running: null, from: null, waiting: false })
    }

    // Safety net: whatever happens (a deck unloaded, a timer lost), the move is over by then.
    window.clearTimeout(this.watchdog)
    this.watchdog = window.setTimeout(
      () => {
        if (token !== this.token || !this.state.running) return
        this.token++
        this.timers.forEach((t) => window.clearTimeout(t))
        this.timers = []
        outboard.throw(from.name as 'A' | 'B', false)
        outboard.setKill(false)
        from.setBend(1)
        this.undo = null
        this.set({ running: null, from: null, waiting: false })
      },
      (wait + lengths[move] + 2) * 1000,
    )

    this.later(wait, () => {
      this.set({ waiting: false })
      switch (move) {
        case 'cut':
          this.bringIn(to)
          this.xfTo(to)
          this.later(beat, () => this.tidy(from, snap))
          break
        case 'echoOut': {
          const name = from.name as 'A' | 'B'
          outboard.throw(name, true)
          this.ramp(beat, (t) => from.setVolume(snap.volume * (1 - t)))
          this.later(beat, () => outboard.throw(name, false))
          // The repeats ring for a bar; the new tune comes in on the next one.
          this.later(beat * 4, () => {
            this.bringIn(to)
            this.xfTo(to)
            this.tidy(from, snap)
            // The old tune's echo fades out under the new one instead of ringing on.
            outboard.damp(beat * 2)
          })
          break
        }
        case 'bassSwap':
          // Both in the mix, the incoming one without bass; at the half, the bass changes hands.
          to.setEq('low', -1)
          this.bringIn(to)
          mixer.setCrossfader(0.5)
          this.later(long / 2, () => {
            from.setEq('low', -1)
            to.setEq('low', 0)
          })
          this.later(long / 2, () => this.xfTo(to, long / 2))
          this.later(long, () => this.tidy(from, snap))
          break
        case 'sweep':
          this.bringIn(to)
          this.xfTo(to, long)
          this.ramp(long, (t) => from.setFilter(t * 0.85))
          this.later(long, () => this.tidy(from, snap))
          break
        case 'tapeStop': {
          const stop = Math.max(0.8, beat * 2)
          if (from.canPitch) this.ramp(stop, (t) => from.setBend(Math.max(0.02, 1 - t * t)))
          this.later(stop, () => {
            this.tidy(from, snap)
            this.bringIn(to)
            this.xfTo(to)
          })
          break
        }
        case 'drop':
          outboard.setKill(true)
          this.later(beat * 4, () => {
            outboard.setKill(false)
            const ready = to.get().kind !== 'none' && !to.get().playing
            if (ready) {
              this.bringIn(to)
              this.xfTo(to)
              this.tidy(from, snap)
            }
          })
          break
      }
      this.later(lengths[move] + 0.05, finish)
    })
  }

  /** Stops a running (or armed) move and puts everything back as it was. */
  cancel(): void {
    if (!this.state.running) return
    window.clearTimeout(this.watchdog)
    this.token++
    this.timers.forEach((t) => window.clearTimeout(t))
    this.timers = []
    this.undo?.()
    this.undo = null
    this.set({ running: null, from: null, waiting: false })
  }
}

export const moves = new Moves()

// While developing, a reloaded copy of this file must not leave a move of the old copy running.
import.meta.hot?.dispose(() => moves.cancel())
