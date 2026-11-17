import { Store, clamp } from '../store'

/** How the DUB button (echo throw) sounds. Shared by both decks and remembered between sessions. */
export interface DubSettings {
  beats: number // echo time in beats (falls back to 120 BPM when the tempo is unknown)
  feedback: number // 0..0.95: how much of each repeat comes back (more = longer tail)
  lowCut: number // Hz: bass cut before the echo, so the repeats do not muddy the low end
  tone: number // Hz: each repeat is darkened at this point, like worn tape
  level: number // 0..1.5: volume of the echo
  space: number // 0..1: spring-style reverb on the repeats
  drift: number // 0..1: tape wobble on the echo time (the pitch bends a little)
  dry: 'keep' | 'cut' // while held: the music keeps playing, or drops out and only the echo is heard
  release: 'ring' | 'fade' // on letting go: the echo rings on, or dies away quickly
  mode: 'hold' | 'latch' // the button works while held, or one press on / one press off
}

export const DUB_BEATS = [
  { value: 0.25, label: '1/4 batida' },
  { value: 0.5, label: '1/2 batida' },
  { value: 0.75, label: '3/4 batida' },
  { value: 1, label: '1 batida' },
  { value: 1.5, label: '1½ batidas' },
  { value: 2, label: '2 batidas' },
]

export const DUB_PRESETS: { name: string; settings: DubSettings }[] = [
  {
    name: 'Clássico',
    settings: { beats: 0.75, feedback: 0.72, lowCut: 380, tone: 3000, level: 1, space: 0, drift: 0, dry: 'keep', release: 'ring', mode: 'hold' },
  },
  {
    name: 'Throw seco',
    settings: { beats: 0.75, feedback: 0.62, lowCut: 500, tone: 3500, level: 1.1, space: 0.15, drift: 0, dry: 'cut', release: 'ring', mode: 'hold' },
  },
  {
    name: 'Espaço',
    settings: { beats: 1, feedback: 0.85, lowCut: 300, tone: 2200, level: 0.9, space: 0.6, drift: 0.25, dry: 'keep', release: 'ring', mode: 'hold' },
  },
  {
    name: 'Fita velha',
    settings: { beats: 0.5, feedback: 0.88, lowCut: 650, tone: 1600, level: 1, space: 0.3, drift: 0.6, dry: 'keep', release: 'ring', mode: 'latch' },
  },
  {
    name: 'Curto',
    settings: { beats: 0.25, feedback: 0.5, lowCut: 600, tone: 5000, level: 0.8, space: 0, drift: 0, dry: 'keep', release: 'fade', mode: 'hold' },
  },
]

export const DUB_LIMITS = {
  feedback: [0.2, 0.95],
  lowCut: [40, 1500],
  tone: [600, 10000],
  level: [0, 1.5],
  space: [0, 1],
  drift: [0, 1],
} as const

const LS = 'vx_dub'

function saved(): DubSettings {
  try {
    return { ...DUB_PRESETS[0].settings, ...JSON.parse(localStorage.getItem(LS) || '{}') }
  } catch {
    return { ...DUB_PRESETS[0].settings }
  }
}

class Dub extends Store<DubSettings> {
  constructor() {
    super(saved())
  }

  update(change: Partial<DubSettings>): void {
    const next = { ...this.state, ...change }
    for (const key of Object.keys(DUB_LIMITS) as (keyof typeof DUB_LIMITS)[]) {
      next[key] = clamp(next[key], DUB_LIMITS[key][0], DUB_LIMITS[key][1])
    }
    if (!DUB_BEATS.some((b) => b.value === next.beats)) next.beats = DUB_PRESETS[0].settings.beats
    this.set(next)
    localStorage.setItem(LS, JSON.stringify(this.state))
  }
}

export const dubSettings = new Dub()
