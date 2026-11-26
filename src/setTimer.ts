import { Store } from './store'

/**
 * Set countdown: how long the DJ still has on stage. It counts on the wall clock (an end time, not a
 * ticking number), so a reload or a busy frame never loses time; past zero it counts the overtime.
 */
export interface SetTimerState {
  length: number // seconds the set lasts
  endsAt: number | null // Date.now() at which it hits zero, while running
  pausedLeft: number | null // seconds left, while paused
  floating: boolean // shown as a movable widget over the app
  x: number // widget position (px from the left / top of the window)
  y: number
}

const LS = 'vx_set_timer'
const PRESETS = [30, 45, 60, 90, 120] as const

function saved(): Partial<SetTimerState> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

class SetTimer extends Store<SetTimerState> {
  readonly presets = PRESETS

  constructor() {
    const s = saved()
    super({
      length: typeof s.length === 'number' && s.length > 0 ? s.length : 60 * 60,
      endsAt: typeof s.endsAt === 'number' ? s.endsAt : null,
      pausedLeft: typeof s.pausedLeft === 'number' ? s.pausedLeft : null,
      floating: !!s.floating,
      x: typeof s.x === 'number' ? s.x : 120,
      y: typeof s.y === 'number' ? s.y : 90,
    })
  }

  protected set(patch: Partial<SetTimerState>): void {
    super.set(patch)
    try {
      localStorage.setItem(LS, JSON.stringify(this.state))
    } catch {
      /* not remembered */
    }
  }

  /** Seconds left (negative once the set has run over). */
  left(): number {
    const s = this.state
    if (s.endsAt !== null) return (s.endsAt - Date.now()) / 1000
    if (s.pausedLeft !== null) return s.pausedLeft
    return s.length
  }

  get running(): boolean {
    return this.state.endsAt !== null
  }

  /** Started and not reset (running or paused). */
  get active(): boolean {
    return this.state.endsAt !== null || this.state.pausedLeft !== null
  }

  /** Seconds of the set already played. */
  elapsed(): number {
    return this.active ? this.state.length - this.left() : 0
  }

  setLength(minutes: number): void {
    const length = Math.round(Math.min(600, Math.max(1, minutes)) * 60)
    // A running or paused set keeps the time already played; only the total changes.
    if (this.state.endsAt !== null) this.set({ length, endsAt: this.state.endsAt + (length - this.state.length) * 1000 })
    else if (this.state.pausedLeft !== null) this.set({ length, pausedLeft: this.state.pausedLeft + (length - this.state.length) })
    else this.set({ length })
  }

  start(): void {
    if (this.state.endsAt !== null) return
    const left = this.state.pausedLeft ?? this.state.length
    this.set({ endsAt: Date.now() + left * 1000, pausedLeft: null })
  }

  pause(): void {
    if (this.state.endsAt === null) return
    this.set({ pausedLeft: this.left(), endsAt: null })
  }

  toggle(): void {
    if (this.running) this.pause()
    else this.start()
  }

  reset(): void {
    this.set({ endsAt: null, pausedLeft: null })
  }

  setFloating(floating: boolean): void {
    this.set({ floating })
  }

  move(x: number, y: number): void {
    this.set({ x: Math.max(0, x), y: Math.max(0, y) })
  }
}

export const setTimer = new SetTimer()

/** 1:05:09 · 42:10 · −0:30 style: hours only when needed. */
export function formatSet(seconds: number): string {
  const over = seconds < 0
  const t = Math.floor(Math.abs(seconds))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = t % 60
  const body = (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0')
  return (over ? '+' : '') + body
}
