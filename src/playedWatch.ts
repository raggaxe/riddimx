import { deckA, deckB, type Deck } from './engine/deck'
import { library } from './library'

/** Like VirtualDJ: a track counts as played once it has been playing on a deck for a moment, not when it is only loaded. */
const AFTER = 8000

function watchDeck(deck: Deck): void {
  let timer = 0
  let was = false
  deck.subscribe(() => {
    const playing = deck.get().playing
    if (playing === was) return
    was = playing
    window.clearTimeout(timer)
    if (playing) timer = window.setTimeout(() => deck.get().playing && library.markPlayed(deck.name), AFTER)
  })
}

let started = false
export function startPlayedWatch(): void {
  if (started) return
  started = true
  watchDeck(deckA)
  watchDeck(deckB)
}
