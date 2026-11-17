import { Store } from './store'

/**
 * What the four pads of each deck do: the same on screen and on the controller.
 * SAMPLER: deck A plays sampler pads 1-4, deck B pads 5-8.
 */
export const PAD_MODES = ['cue', 'loop', 'stems', 'sampler'] as const
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

/** First sampler pad a deck's pads play in SAMPLER mode. */
export const samplerBase = (deck: string): number => (deck === 'B' ? 4 : 0)
