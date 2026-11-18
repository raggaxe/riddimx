import { Store } from './store'
import type { Deck } from './engine/deck'
import { ALL_STEMS, STEMS, type StemState } from './engine/stems'

/**
 * What the four pads of each deck do: the same on screen and on the controller.
 * RIDDIM: the song taken apart with its stems in one press (version, acapella, drum & bass, all back).
 */
export const PAD_MODES = ['cue', 'loop', 'stems', 'riddim'] as const
export type PadMode = (typeof PAD_MODES)[number]

class PadModes extends Store<Record<'A' | 'B', PadMode>> {
  constructor() {
    super({ A: 'cue', B: 'cue' })
  }

  setMode(deck: 'A' | 'B', mode: PadMode): void {
    this.set({ [deck]: mode } as Partial<Record<'A' | 'B', PadMode>>)
  }

  /** Next (or previous) mode, round all of them. */
  step(deck: 'A' | 'B', by: 1 | -1): void {
    const at = PAD_MODES.indexOf(this.state[deck])
    this.setMode(deck, PAD_MODES[(at + by + PAD_MODES.length) % PAD_MODES.length])
  }
}

export const padModes = new PadModes()

/** The RIDDIM pads: which parts of the song each one leaves playing. */
export const RIDDIM_PADS: { label: string; short: string; hint: string; stems: StemState }[] = [
  {
    label: 'VERSION',
    short: 'VERS',
    hint: 'Riddim version: tudo menos a voz',
    stems: { ...ALL_STEMS, vocal: false },
  },
  {
    label: 'ACAPELLA',
    short: 'ACAP',
    hint: 'Acapella: só a voz',
    stems: { vocal: true, instr: false, bass: false, kick: false, hat: false },
  },
  {
    label: 'D&B',
    short: 'D&B',
    hint: 'Só baixo e bateria: sem voz nem instrumentos',
    stems: { vocal: false, instr: false, bass: true, kick: true, hat: true },
  },
  {
    label: 'TUDO',
    short: 'TUDO',
    hint: 'A música inteira de volta',
    stems: { ...ALL_STEMS },
  },
]

/** Whether the deck's stems are exactly what RIDDIM pad `i` leaves playing. */
export function riddimOn(stems: StemState, i: number): boolean {
  return STEMS.every((st) => stems[st] === RIDDIM_PADS[i].stems[st])
}

/** RIDDIM pad `i`: its parts; pressed again while on, the whole song comes back. */
export function riddimPad(deck: Deck, i: number): void {
  const on = riddimOn(deck.get().stems, i)
  deck.setStems(on ? { ...ALL_STEMS } : RIDDIM_PADS[i].stems)
}
