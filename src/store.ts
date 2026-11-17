import { useSyncExternalStore } from 'react'

/** Minimal observable state container; engine classes extend it so React and MIDI share one source of truth. */
export class Store<T> {
  protected state: T
  private listeners = new Set<() => void>()

  constructor(initial: T) {
    this.state = initial
  }

  get = (): T => this.state

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  protected set(patch: Partial<T>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((fn) => fn())
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get)
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
