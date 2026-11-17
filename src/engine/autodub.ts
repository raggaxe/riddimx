import { Store } from '../store'
import { decks, type Deck } from './deck'
import { liveDeck, outboard } from './outboard'
import type { Stem, StemState } from './stems'

/**
 * Automatic dub: the deck playing is taken apart and put back together on the beat, the way a dub
 * engineer rides the desk. Every few bars a new "scene" (which parts of the music sound); the last
 * word of a phrase is thrown into the tape echo; sometimes the spring is hit or the bass drops out
 * and comes back on the one. Turned off, everything is put back as it was.
 */

export type DubLevel = 'leve' | 'medio' | 'pesado'

interface Scene {
  name: string // what the screen shows
  stems: Partial<StemState>
}

const ALL: StemState = { vocal: true, instr: true, bass: true, kick: true, hat: true }

/** The desk moves, from the full song down to the bare riddim. */
const SCENES: Record<string, Scene> = {
  full: { name: 'Tudo', stems: ALL },
  riddim: { name: 'Sem voz', stems: { ...ALL, vocal: false } },
  drumbass: { name: 'Baixo e bateria', stems: { vocal: false, instr: false, bass: true, kick: true, hat: true } },
  bass: { name: 'Só baixo e bombo', stems: { vocal: false, instr: false, bass: true, kick: true, hat: false } },
  drums: { name: 'Só bateria', stems: { vocal: false, instr: false, bass: false, kick: true, hat: true } },
  skank: { name: 'Instrumentos e bateria', stems: { vocal: false, instr: true, bass: false, kick: true, hat: true } },
  voice: { name: 'Voz com o baixo', stems: { vocal: true, instr: false, bass: true, kick: true, hat: false } },
}

/** Which scenes each level uses, and how often it changes (in bars). */
const LEVELS: Record<
  DubLevel,
  { label: string; hint: string; scenes: string[]; every: number; throws: number; crash: number; drop: number }
> = {
  leve: {
    label: 'Leve',
    hint: 'Muda devagar (a cada 8 compassos), quase sempre com o riddim inteiro; poucos ecos',
    scenes: ['full', 'riddim', 'drumbass', 'riddim'],
    every: 8,
    throws: 0.35,
    crash: 0,
    drop: 0,
  },
  medio: {
    label: 'Médio',
    hint: 'A cada 4 compassos tira e põe partes; eco na última palavra das frases',
    scenes: ['full', 'riddim', 'drumbass', 'voice', 'bass', 'riddim', 'full'],
    every: 4,
    throws: 0.6,
    crash: 0.15,
    drop: 0.15,
  },
  pesado: {
    label: 'Pesado',
    hint: 'Desmonta a música toda: só baixo, só bateria, ecos e molas a cada passo, drops no um',
    scenes: ['drumbass', 'bass', 'drums', 'voice', 'skank', 'full', 'bass'],
    every: 4,
    throws: 0.85,
    crash: 0.35,
    drop: 0.3,
  },
}

export const DUB_LEVELS = LEVELS

export interface AutoDubState {
  on: boolean
  level: DubLevel
  deck: 'A' | 'B' | null // the deck being dubbed
  scene: string // scene name now
  doing: string | null // a move happening now ("Eco", "Mola", "Drop")
  grid: boolean // the deck has a beat grid (changes land on the bar); without it they follow the clock
}

class AutoDub extends Store<AutoDubState> {
  private timer = 0
  private lastBeat = -1
  private sceneAt = 0
  private target: Deck | null = null
  private before: StemState | null = null
  private clockStart = 0

  constructor() {
    super({ on: false, level: 'medio', deck: null, scene: '', doing: null, grid: false })
  }

  setLevel(level: DubLevel): void {
    this.set({ level })
  }

  toggle(): void {
    if (this.state.on) this.stop()
    else this.start()
  }

  start(): void {
    const deck = liveDeck() ?? decks.find((d) => d.get().playing) ?? null
    if (!deck || !deck.canStems) return
    this.target = deck
    this.before = { ...deck.get().stems }
    this.lastBeat = -1
    this.sceneAt = 0
    this.clockStart = performance.now()
    this.set({ on: true, deck: deck.name as 'A' | 'B', scene: SCENES.full.name, doing: null })
    this.timer = window.setInterval(() => this.tick(), 25)
  }

  /** Off: the parts come back as they were before it started, the echo throw is let go. */
  stop(): void {
    window.clearInterval(this.timer)
    const deck = this.target
    if (deck && this.before) deck.setStems(this.before)
    if (deck) outboard.throw(deck.name as 'A' | 'B', false)
    outboard.setKill(false)
    this.target = null
    this.before = null
    this.set({ on: false, deck: null, scene: '', doing: null })
  }

  /** Beat number of the deck now (from its beat grid), or from the clock at its tempo without one. */
  private beatNow(deck: Deck): { beat: number; len: number; grid: boolean } {
    const s = deck.get()
    const len = s.bpm ? 60 / (s.bpm * s.rate) : 0.5
    if (s.bpm && s.anchor !== null) {
      const beatTrack = 60 / s.bpm
      return { beat: Math.floor((deck.getPosition() - s.anchor) / beatTrack), len, grid: true }
    }
    return { beat: Math.floor((performance.now() - this.clockStart) / 1000 / len), len, grid: false }
  }

  private tick(): void {
    const deck = this.target
    if (!deck || !deck.get().playing || deck.get().kind === 'none') return this.stop()
    const { beat, len, grid } = this.beatNow(deck)
    if (beat === this.lastBeat) return
    this.lastBeat = beat
    if (grid !== this.state.grid) this.set({ grid })
    this.onBeat(deck, beat, len)
  }

  private flash(doing: string, seconds: number): void {
    this.set({ doing })
    window.setTimeout(() => this.state.doing === doing && this.set({ doing: null }), seconds * 1000)
  }

  private onBeat(deck: Deck, beat: number, len: number): void {
    const level = LEVELS[this.state.level]
    const inBar = ((beat % 4) + 4) % 4
    const bar = Math.floor(beat / 4)
    const phraseBars = level.every
    const barInPhrase = ((bar % phraseBars) + phraseBars) % phraseBars
    const name = deck.name as 'A' | 'B'

    // Last beat of a phrase: throw the last word into the echo.
    if (barInPhrase === phraseBars - 1 && inBar === 3 && Math.random() < level.throws) {
      outboard.throw(name, true)
      window.setTimeout(() => outboard.throw(name, false), len * 900)
      this.flash('Eco', len * 2)
    }
    // Last bar of a phrase, sometimes: the bass drops out, to come back with the new scene on the one.
    if (barInPhrase === phraseBars - 1 && inBar === 0 && Math.random() < level.drop) {
      outboard.setKill(true)
      this.flash('Drop', len * 4)
    }

    // The one of a new phrase: next scene, bass back in, maybe the spring.
    if (barInPhrase === 0 && inBar === 0) {
      outboard.setKill(false)
      const scenes = level.scenes
      this.sceneAt = (this.sceneAt + 1) % scenes.length
      // Never the same scene twice in a row.
      let key = scenes[this.sceneAt]
      if (SCENES[key].name === this.state.scene) key = scenes[(this.sceneAt + 1) % scenes.length]
      const scene = SCENES[key]
      deck.setStems(scene.stems as Partial<Record<Stem, boolean>>)
      this.set({ scene: scene.name })
      if (Math.random() < level.crash) {
        outboard.crash()
        this.flash('Mola', len * 2)
      }
    }
  }
}

export const autoDub = new AutoDub()
