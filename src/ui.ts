import { Store, clamp } from './store'
import { settings } from './settings'
import { desktop } from './engine/ytremote'

export type Tab = 'library' | 'sampler' | 'dubbox' | 'echo' | 'voice' | 'plugin' | 'master' | 'spotify'

/** Pages of the Ajustes window (a modal over the app). */
export type SettingsPage = 'geral' | 'decks' | 'audio' | 'midi' | 'contas' | 'celular' | 'ia'

/** Heights of the resizable parts of the window (the decks and mixer take what is left). */
export interface Layout {
  track: number // scrolling waveforms at the top
  bottom: number // browser / tabs at the bottom
}

/**
 * Decks and mixer: never shorter than STAGE_MIN, never taller than STAGE_FIT (what their controls
 * need). Every height here is in base pixels, before the global scale.
 */
/** The stage (decks and the centre's pages) needs this much to keep the turntable and the DUB page usable. */
const STAGE_MIN = 330
const STAGE_FIT = 380
/** Pro shows a row of pad mode tabs over the pads: the decks need this much more. */
const PRO_EXTRA = 24
const CHROME = 30 + 14 // top bar and the two dividers
let rack = 0 // height of the rack above the decks: none since the Dub Box moved into the centre's DUB page
/** v4: the library's height is kept as a share of the window, so resizing the window keeps the proportion. */
const LS = 'vx_layout_v5' // v5: the stage got taller (the DUB FX row moved into the centre)
/** The library's default share of the window height (laptop-first: the browser is what DJs look at most). */
const LIB_SHARE = 0.43
const TRACK_DEFAULT = 60

/**
 * One scale for the whole interface, like a DJ skin: the layout is drawn for a 1440×900 window, and
 * any other window shows it enlarged as one piece (fonts, pads, knobs, jog, faders, gaps and the
 * heights here). Never below 1, so a laptop keeps every text at 10 px or more. The Size setting
 * multiplies it.
 * In the desktop app the window does the scaling (webContents zoom, see electron/main.cjs), so the
 * page already measures in base pixels and this is 1. In a browser the app zooms itself.
 */
const BASE_W = 1440
const BASE_H = 900
export function uiScale(): number {
  if (desktop?.setZoom) return 1
  return Math.max(1, Math.min(window.innerWidth / BASE_W, window.innerHeight / BASE_H)) * settings.get().zoom
}

function applyScale(): number {
  const s = uiScale()
  document.documentElement.style.setProperty('--ui-scale', String(s))
  return s
}

/** The window height in base pixels. */
const viewH = () => window.innerHeight / uiScale()

/** What is remembered: the waveform height (base px) and the library's share of the window. */
interface Prefs {
  track: number
  lib: number
}

function savedPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(LS) || '{}')
    return {
      track: typeof p.track === 'number' ? p.track : TRACK_DEFAULT,
      lib: typeof p.lib === 'number' ? p.lib : LIB_SHARE,
    }
  } catch {
    return { track: TRACK_DEFAULT, lib: LIB_SHARE }
  }
}

/**
 * Pixel heights from the remembered proportions. The decks and mixer never get more than they need:
 * any room left over goes to the library, and a small window takes from the library first.
 */
function fit(p: Prefs, mode: UiMode): Layout {
  const h = viewH()
  const room = h - CHROME - rack
  const extra = mode === 'pro' ? PRO_EXTRA : 0
  const track = clamp(p.track, 36, Math.max(36, Math.min(260, room - STAGE_MIN - extra - 90)))
  const most = Math.max(90, room - track - STAGE_MIN - extra)
  const least = Math.min(most, Math.max(90, room - track - STAGE_FIT - extra))
  return { track, bottom: Math.round(clamp(p.lib * h, least, most)) }
}

/** The default split: waveforms at 60 px, the library at about 43% of the window, the decks the rest. */
export function defaultLayout(): Layout {
  return fit({ track: TRACK_DEFAULT, lib: LIB_SHARE }, ui.get().mode)
}

/** Which bottom tab is open, and how the window is divided; shared so any control can change them. */
/**
 * Simple: what most sets need (decks, a basic mixer, DUB and FIRE, library, sampler). Pro: every unit.
 * Everyone starts in Simple; the choice is remembered.
 */
export type UiMode = 'simple' | 'pro'
const LS_MODE = 'vx_ui_mode'
/** Tabs shown in Simple mode. */
export const SIMPLE_TABS: Tab[] = ['library', 'sampler', 'spotify']

function savedMode(): UiMode {
  try {
    return localStorage.getItem(LS_MODE) === 'pro' ? 'pro' : 'simple'
  } catch {
    return 'simple'
  }
}

/** The centre of the stage shows one page at a time: the mixer, the Dub Box, the effects, the deck DUB echo or the tape echo. */
export type Centre = 'mixer' | 'dub' | 'fx' | 'echo' | 'tape' | 'mic'
const LS_CENTRE = 'vx_centre'
function savedCentre(): Centre {
  try {
    // ?centre=dub opens that page (handy for links and screenshots).
    const c = new URLSearchParams(location.search).get('centre') ?? localStorage.getItem(LS_CENTRE)
    return c === 'dub' || c === 'fx' || c === 'echo' || c === 'tape' || c === 'mic' ? c : c === 'aux' ? 'fx' : 'mixer'
  } catch {
    return 'mixer'
  }
}

class Ui extends Store<{ tab: Tab; layout: Layout; settings: SettingsPage | null; mode: UiMode; centre: Centre }> {
  constructor() {
    // ?tab=plugin opens that tab at start (handy for links and screenshots).
    const asked = new URLSearchParams(location.search).get('tab') as Tab | null
    const TABS: Tab[] = ['library', 'sampler', 'dubbox', 'echo', 'voice', 'plugin', 'master', 'spotify']
    const mode = new URLSearchParams(location.search).get('mode') === 'pro' ? 'pro' : savedMode()
    const tab = asked && TABS.includes(asked) && (mode === 'pro' || SIMPLE_TABS.includes(asked)) ? asked : 'library'
    applyScale()
    const prefs = savedPrefs()
    super({ tab, layout: fit(prefs, mode), settings: null, mode, centre: savedCentre() })
    this.prefs = prefs
  }

  /** The remembered proportions; the pixel layout is worked out from them for the current window. */
  private prefs: Prefs

  /** The window changed size: same proportions, new pixels (and maybe a new scale). */
  refit(): void {
    applyScale()
    this.set({ layout: fit(this.prefs, this.state.mode) })
  }

  open(tab: Tab): void {
    // A unit asked from Simple mode (e.g. the Dub Box's settings) switches to Pro so it can show.
    if (this.state.mode === 'simple' && !SIMPLE_TABS.includes(tab)) this.setMode('pro')
    this.set({ tab })
  }

  setMode(mode: UiMode): void {
    const tab = mode === 'simple' && !SIMPLE_TABS.includes(this.state.tab) ? 'library' : this.state.tab
    this.set({ mode, tab })
    this.refit() // Pro's decks are a little taller
    try {
      localStorage.setItem(LS_MODE, mode)
    } catch {
      /* not remembered */
    }
  }

  setCentre(centre: Centre): void {
    this.set({ centre })
    try {
      localStorage.setItem(LS_CENTRE, centre)
    } catch {
      /* not remembered */
    }
  }

  /** Ajustes: opens on a page (or the last one), closes with null. */
  openSettings(page: SettingsPage | null = 'geral'): void {
    this.set({ settings: page })
  }

  /** The rack reports its height (it grows a row when its units wrap); the browser gives way if needed. */
  setRack(height: number): void {
    if (height === rack) return
    rack = height
    // The library absorbs the change: a shorter rack gives it room, a taller one takes from it.
    this.refit()
  }

  /**
   * A divider moved (heights in base px). The library's new height is remembered as a share of the
   * window; the decks and mixer never get less than STAGE_MIN nor more than STAGE_FIT.
   */
  resize(change: Partial<Layout>): void {
    const next = { ...this.state.layout, ...change }
    const prefs: Prefs = { track: next.track, lib: this.prefs.lib }
    if (change.bottom !== undefined) prefs.lib = next.bottom / viewH()
    const layout = fit(prefs, this.state.mode)
    // Keep what was actually given, so a drag past the limit does not build up a hidden excess.
    this.prefs = { track: layout.track, lib: layout.bottom / viewH() }
    this.set({ layout })
    try {
      localStorage.setItem(LS, JSON.stringify(this.prefs))
    } catch {
      /* not remembered */
    }
  }
}

export const ui = new Ui()

// In a browser the Size setting is part of the app's own zoom: a change re-fits the layout.
settings.subscribe(() => ui.refit())
