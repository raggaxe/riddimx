import { Store, clamp } from './store'
import { desktop } from './engine/ytremote'

/** The DJ's own preferences: size of the interface, deck colours, and a few behaviours. Kept between sessions. */
export interface Settings {
  zoom: number // size of the whole interface (1 = 100%)
  colorA: string // deck A
  colorB: string // deck B
  snapBars: boolean // a stopped deck moved by hand sticks a little to the head of each bar
  jogInertia: boolean // the on-screen platter keeps turning when thrown
  beatCounter: boolean // the four boxes per deck at the top
}

export const DEFAULT_SETTINGS: Settings = {
  zoom: 1,
  colorA: '#e5484d', // red
  colorB: '#4aa8ff', // blue
  snapBars: true,
  jogInertia: true,
  beatCounter: true,
}

export const ZOOM_MIN = 0.7
export const ZOOM_MAX = 1.6
const LS = 'vx_settings'

function saved(): Settings {
  try {
    const s = { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(LS) || '{}') } as Settings
    s.zoom = clamp(Number(s.zoom) || 1, ZOOM_MIN, ZOOM_MAX)
    // The old default pair (gold / green), never changed by the DJ: moves to the new default (red / blue).
    if (s.colorA === '#f2c230' && s.colorB === '#35c46a')
      Object.assign(s, { colorA: DEFAULT_SETTINGS.colorA, colorB: DEFAULT_SETTINGS.colorB })
    if (!/^#[0-9a-f]{6}$/i.test(s.colorA)) s.colorA = DEFAULT_SETTINGS.colorA
    if (!/^#[0-9a-f]{6}$/i.test(s.colorB)) s.colorB = DEFAULT_SETTINGS.colorB
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

class SettingsStore extends Store<Settings> {
  constructor() {
    super(saved())
    this.apply()
    // Desktop app: ⌘+ / ⌘− / ⌘0 come from the window (they would otherwise go to the menu's own zoom).
    desktop?.onZoomKey?.((step: number) => (step === 0 ? this.update({ zoom: 1 }) : this.zoomBy(step)))
  }

  update(change: Partial<Settings>): void {
    const next = { ...this.state, ...change }
    next.zoom = clamp(Math.round(next.zoom * 100) / 100, ZOOM_MIN, ZOOM_MAX)
    this.set(next)
    this.apply()
    try {
      localStorage.setItem(LS, JSON.stringify(this.state))
    } catch {
      /* not remembered */
    }
  }

  /** One step bigger (+1) or smaller (−1): 10% at a time. */
  zoomBy(step: number): void {
    this.update({ zoom: this.state.zoom + step * 0.1 })
  }

  reset(): void {
    this.update({ ...DEFAULT_SETTINGS })
  }

  /** Colours go to the CSS variables every panel uses; the size to the window (desktop) or the page. */
  private apply(): void {
    const root = document.documentElement.style
    root.setProperty('--a', this.state.colorA)
    root.setProperty('--b', this.state.colorB)
    // Desktop: the window scales the page (fit to the window × this size). In a browser the app
    // applies the same product itself as a CSS zoom (see uiScale in ui.ts).
    if (desktop?.setZoom) void desktop.setZoom(this.state.zoom)
  }
}

export const settings = new SettingsStore()

/** Browser (no desktop shell): ⌘/Ctrl + = − 0 change the interface size too. */
if (!desktop?.onZoomKey) {
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return
    if (e.key === '=' || e.key === '+') settings.zoomBy(1)
    else if (e.key === '-') settings.zoomBy(-1)
    else if (e.key === '0') settings.update({ zoom: 1 })
    else return
    e.preventDefault()
  })
}
