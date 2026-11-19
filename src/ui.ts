import { Store, clamp } from './store'

export type Tab = 'library' | 'sampler' | 'dubbox' | 'echo' | 'voice' | 'master' | 'spotify'

/** Pages of the Ajustes window (a modal over the app). */
export type SettingsPage = 'geral' | 'decks' | 'audio' | 'midi' | 'contas' | 'celular' | 'ia'

/** Heights of the resizable parts of the window (the decks and mixer take what is left). */
export interface Layout {
  track: number // scrolling waveforms at the top
  bottom: number // browser / tabs at the bottom
}

/** Decks and mixer: never shorter than this, and by default just as tall as their controls need. */
const STAGE_MIN = 250
const STAGE_FIT = 272
const CHROME = 30 + 14 // top bar and the two dividers
let rack = 52 // height of the rack of outboard units above the decks (always one row)
const LS = 'vx_layout_v3' // v3: compact decks; older saved heights are dropped so the browser gets the room

/** By default the decks and mixer get what their controls need and the browser gets the rest. */
export function defaultLayout(): Layout {
  const track = 60
  return { track, bottom: Math.max(90, window.innerHeight - CHROME - rack - track - STAGE_FIT) }
}

function saved(): Layout {
  try {
    return { ...defaultLayout(), ...JSON.parse(localStorage.getItem(LS) || '{}') }
  } catch {
    return defaultLayout()
  }
}

/** Which bottom tab is open, and how the window is divided; shared so any control can change them. */
class Ui extends Store<{ tab: Tab; layout: Layout; settings: SettingsPage | null }> {
  constructor() {
    super({ tab: 'library', layout: saved(), settings: null })
    this.resize({}) // a layout saved before the rack existed may leave the decks too little room
    // Room the decks do not need (left over from a taller rack, or a bigger window) goes to the browser.
    const spare = window.innerHeight - CHROME - rack - this.state.layout.track - this.state.layout.bottom - STAGE_FIT
    if (spare > 0) this.resize({ bottom: this.state.layout.bottom + spare })
  }

  open(tab: Tab): void {
    this.set({ tab })
  }

  /** Ajustes: opens on a page (or the last one), closes with null. */
  openSettings(page: SettingsPage | null = 'geral'): void {
    this.set({ settings: page })
  }

  /** The rack reports its height (it grows a row when its units wrap); the browser gives way if needed. */
  setRack(height: number): void {
    if (height === rack) return
    const freed = rack - height
    rack = height
    // A shorter rack gives its room back to the browser; a taller one takes it from there.
    this.resize(freed > 0 ? { bottom: this.state.layout.bottom + freed } : {})
  }

  /** Keeps every part usable: the decks and mixer never get less than STAGE_MIN. */
  resize(change: Partial<Layout>): void {
    const next = { ...this.state.layout, ...change }
    const room = window.innerHeight - CHROME - rack
    next.track = clamp(next.track, 36, 260)
    next.bottom = clamp(next.bottom, 90, Math.max(90, room - next.track - STAGE_MIN))
    this.set({ layout: next })
    try {
      localStorage.setItem(LS, JSON.stringify(next))
    } catch {
      /* not remembered */
    }
  }
}

export const ui = new Ui()
