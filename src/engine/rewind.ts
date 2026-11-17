import { Store, clamp } from '../store'

/** How the rewind (◀◀ / pull up) behaves. Shared by both decks and remembered between sessions. */
export interface RewindSettings {
  duration: number // seconds the rewind sound lasts
  tape: number // seconds of music it runs back through (the deck keeps the last 4 s)
  startSpeed: number // backwards speed at the start (1 = normal)
  endSpeed: number // backwards speed at the end
  fadeAt: number // 0..1: point of the rewind where it starts to fade out
  muffle: number // 0..1: how much the sound darkens as it spins (a hand slowing the platter)
  shout: string // sound-system effect played with it ('' = none)
  after: 'cue' | 'drop' | 'stay' // stop on the cue · drop the track again from the cue · stop where it was
}

export const REWIND_PRESETS: { name: string; settings: RewindSettings }[] = [
  {
    name: 'Clássico',
    settings: { duration: 1.05, tape: 2.4, startSpeed: 0.9, endSpeed: 3.2, fadeAt: 0.52, muffle: 0, shout: '', after: 'cue' },
  },
  {
    name: 'Rápido',
    settings: { duration: 0.6, tape: 2, startSpeed: 1.4, endSpeed: 5, fadeAt: 0.45, muffle: 0.2, shout: '', after: 'cue' },
  },
  {
    name: 'Pull up!',
    settings: { duration: 1.3, tape: 3, startSpeed: 0.8, endSpeed: 3.5, fadeAt: 0.6, muffle: 0.3, shout: 'pull-up', after: 'drop' },
  },
  {
    name: 'Dub longo',
    settings: { duration: 2.6, tape: 4, startSpeed: 0.5, endSpeed: 2.4, fadeAt: 0.55, muffle: 0.7, shout: '', after: 'cue' },
  },
]

export const REWIND_LIMITS = {
  duration: [0.3, 4],
  tape: [0.5, 4],
  startSpeed: [0.3, 2],
  endSpeed: [1, 8],
  fadeAt: [0, 0.95],
  muffle: [0, 1],
} as const

const LS = 'vx_rewind'

function saved(): RewindSettings {
  try {
    return { ...REWIND_PRESETS[0].settings, ...JSON.parse(localStorage.getItem(LS) || '{}') }
  } catch {
    return { ...REWIND_PRESETS[0].settings }
  }
}

class Rewind extends Store<RewindSettings> {
  constructor() {
    super(saved())
  }

  update(change: Partial<RewindSettings>): void {
    const next = { ...this.state, ...change }
    for (const key of Object.keys(REWIND_LIMITS) as (keyof typeof REWIND_LIMITS)[]) {
      next[key] = clamp(next[key], REWIND_LIMITS[key][0], REWIND_LIMITS[key][1])
    }
    // The end speed may not be slower than the start: it would sound like a brake, not a rewind.
    next.endSpeed = Math.max(next.endSpeed, next.startSpeed)
    this.set(next)
    localStorage.setItem(LS, JSON.stringify(this.state))
  }
}

export const rewindSettings = new Rewind()
