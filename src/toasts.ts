import { Store } from './store'

export type ToastKind = 'error' | 'warn' | 'info' | 'update'

export interface ToastAction {
  label: string
  run: () => void
  primary?: boolean
  /** Leave the toast open after running (e.g. DOWNLOAD turns it into a progress toast). */
  keep?: boolean
}

export interface Toast {
  id: number
  /** Same key = same subject: a new message replaces the old one instead of stacking up. */
  key?: string
  kind: ToastKind
  title: string
  body?: string
  /** Longer text behind a "What's new" / "Details" toggle. */
  details?: string
  detailsLabel?: string
  actions?: ToastAction[]
  /** 0..1: a progress bar (downloads). */
  progress?: number
  /** Stays until closed (updates); otherwise it goes after a while. */
  sticky?: boolean
}

type Input = Omit<Toast, 'id'>

const MAX = 4
const LIFE: Record<ToastKind, number> = { error: 10000, warn: 8000, info: 5000, update: 0 }

/**
 * Every message the app gives the DJ — errors, warnings, a new version — as a toast in the corner,
 * each with a close key. One subject (key) shows once; the newest is on top.
 */
class Toasts extends Store<{ list: Toast[] }> {
  private next = 1
  private timers = new Map<number, number>()

  constructor() {
    super({ list: [] })
  }

  show(t: Input): number {
    const old = t.key ? this.state.list.find((x) => x.key === t.key) : undefined
    const id = old?.id ?? this.next++
    const toast: Toast = { ...t, id }
    const rest = this.state.list.filter((x) => x.id !== id)
    const list = [toast, ...rest]
    // Too many: the oldest one that is not sticky goes first.
    while (list.length > MAX) {
      const drop = [...list].reverse().find((x) => !x.sticky) ?? list[list.length - 1]
      list.splice(list.indexOf(drop), 1)
      this.clearTimer(drop.id)
    }
    this.set({ list })
    this.arm(toast)
    return id
  }

  /** Changes a toast in place (progress, new text) without moving it or restarting its timer. */
  update(key: string, patch: Partial<Input>): void {
    const list = this.state.list.map((x) => (x.key === key ? { ...x, ...patch } : x))
    this.set({ list })
  }

  has(key: string): boolean {
    return this.state.list.some((x) => x.key === key)
  }

  dismiss(id: number): void {
    this.clearTimer(id)
    this.set({ list: this.state.list.filter((x) => x.id !== id) })
  }

  dismissKey(key: string): void {
    const t = this.state.list.find((x) => x.key === key)
    if (t) this.dismiss(t.id)
  }

  /** The pointer is over the toasts: none of them goes away meanwhile. */
  hold(on: boolean): void {
    if (on) this.timers.forEach((_, id) => this.clearTimer(id))
    else this.state.list.forEach((t) => this.arm(t))
  }

  private arm(t: Toast): void {
    this.clearTimer(t.id)
    const life = t.sticky ? 0 : LIFE[t.kind]
    if (life) this.timers.set(t.id, window.setTimeout(() => this.dismiss(t.id), life))
  }

  private clearTimer(id: number): void {
    const timer = this.timers.get(id)
    if (timer !== undefined) window.clearTimeout(timer)
    this.timers.delete(id)
  }
}

export const toasts = new Toasts()

export const toast = {
  error: (title: string, body?: string, more: Partial<Input> = {}) => toasts.show({ kind: 'error', title, body, ...more }),
  warn: (title: string, body?: string, more: Partial<Input> = {}) => toasts.show({ kind: 'warn', title, body, ...more }),
  info: (title: string, body?: string, more: Partial<Input> = {}) => toasts.show({ kind: 'info', title, body, ...more }),
}
