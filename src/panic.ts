import { decks } from './engine/deck'
import { mixer } from './engine/mixer'
import { outboard } from './engine/outboard'
import { dubBox } from './engine/dubbox'
import { sampler } from './engine/sampler'
import { mic } from './engine/mic'
import { autoDub } from './engine/autodub'
import { library } from './library'
import { Store } from './store'

/**
 * PANIC: when the sound goes wrong mid-set (an interface that changed sample rate, a stuck echo
 * feeding back, crackle, silence), one press puts the audio engine back the way it was last used.
 *
 * 1. Everything that rings on its own stops: DUB and THROW let go, echo tails cut, Dub Box, sampler
 *    and mic throw silenced, AUTO DUB off.
 * 2. The sound card is closed and opened again on the same outputs, with the same master settings.
 *    The music keeps its place.
 * 3. If the engine still does not run, the window restarts and the tracks come back on their decks
 *    where they were, stopped, with their CUE.
 */
type PanicState = { busy: boolean; last: 'ok' | 'restart' | null }

const RESTORE = 'vx_panic_restore'

class Panic extends Store<PanicState> {
  constructor() {
    super({ busy: false, last: null })
  }

  async run(): Promise<void> {
    if (this.state.busy) return
    this.set({ busy: true })
    for (const d of decks) d.panic()
    outboard.panic()
    dubBox.panic()
    sampler.stopAll()
    if (mic.get().throwing) mic.throwVoice(false)
    if (autoDub.get().on) autoDub.stop()
    const running = await mixer.reopen()
    if (running) {
      this.set({ busy: false, last: 'ok' })
      return
    }
    this.restart()
  }

  /** Last resort: the whole window starts again, and the decks are loaded back where they were. */
  private restart(): void {
    const onDeck = library.get().onDeck
    const saved = decks
      .map((d) => {
        const s = d.get()
        const id = onDeck[d.name]
        return s.kind !== 'none' && id ? { deck: d.name, id, pos: d.getPosition(), cue: s.cue } : null
      })
      .filter(Boolean)
    try {
      sessionStorage.setItem(RESTORE, JSON.stringify(saved))
    } catch {
      /* the decks start empty */
    }
    this.set({ last: 'restart' })
    location.reload()
  }

  /** After a PANIC restart: the tracks back on their decks, at the same place. */
  restore(): void {
    let saved: { deck: string; id: string; pos: number; cue: number }[] = []
    try {
      saved = JSON.parse(sessionStorage.getItem(RESTORE) ?? '[]')
      sessionStorage.removeItem(RESTORE)
    } catch {
      return
    }
    for (const item of saved) {
      const deck = decks.find((d) => d.name === item.deck)
      const entry = library.byId(item.id)
      if (!deck || !entry || !library.playable(entry)) continue
      library.load(entry, deck)
      const started = Date.now()
      const stop = deck.subscribe(() => {
        const s = deck.get()
        if (s.kind !== 'none' && s.duration > 0) {
          stop()
          deck.cueAt(item.cue)
          deck.seek(item.pos)
        } else if (Date.now() - started > 30000) stop()
      })
    }
  }
}

export const panic = new Panic()

// The library reads its entries as it starts; the decks come back once it has.
queueMicrotask(() => panic.restore())
