import { Store } from '../store'
import { findBpm } from './lookup'

/**
 * BPM knowledge for streaming tracks, keyed "youtube:<id>" / "spotify:<id>".
 *
 * A deck cannot read YouTube/Spotify audio, so the BPM comes from elsewhere:
 *  1. lookup(): automatic. Finds the song in public catalogues and analyses their 30 s preview.
 *  2. request(): optional fallback. A separate "analyzer" window (analyzer.html) plays the video
 *     silently and measures it; needs the user to share that tab's audio.
 * Every result is remembered in localStorage, so a track is only ever analysed once.
 */

export type AnalyzerMessage =
  | { type: 'hello' } // app → analyzer: report your status
  | { type: 'analyze'; refs: string[]; urgent: boolean } // app → analyzer
  | { type: 'status'; active: boolean; current: string | null } // analyzer → app (also heartbeat)
  | { type: 'result'; ref: string; bpm: number | null } // analyzer → app

export const ANALYZER_CHANNEL = 'vx-analyzer'

export interface BpmState {
  bpms: Record<string, number>
  looking: string[] // online lookup in progress or queued
  pending: string[] // waiting for the analyzer window
  failed: string[] // lookup found nothing
  analyzerOn: boolean
  current: string | null
}

const LS_BPM = 'vx_bpm'
const LS_GRID = 'vx_grid'
type ResultListener = (ref: string, bpm: number) => void

function read(key = LS_BPM): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(key) || '{}')
  } catch {
    return {}
  }
}

class BpmStore extends Store<BpmState> {
  private channel = new BroadcastChannel(ANALYZER_CHANNEL)
  private lastBeat = 0
  private resultListeners = new Set<ResultListener>()

  constructor() {
    super({ bpms: read(), looking: [], pending: [], failed: [], analyzerOn: false, current: null })
    this.channel.onmessage = (e) => this.onMessage(e.data as AnalyzerMessage)
    // The analyzer window sends a heartbeat; silence means it was closed.
    window.setInterval(() => {
      if (this.state.analyzerOn && Date.now() - this.lastBeat > 6000) this.set({ analyzerOn: false, current: null })
    }, 2000)
    this.post({ type: 'hello' })
  }

  private post(message: AnalyzerMessage): void {
    this.channel.postMessage(message)
  }

  bpm(ref: string): number | null {
    return this.state.bpms[ref] ?? null
  }

  /** Store (or with null, forget) a BPM for a track. */
  remember(ref: string, bpm: number | null): void {
    const bpms = { ...this.state.bpms }
    if (bpm) bpms[ref] = bpm
    else delete bpms[ref]
    localStorage.setItem(LS_BPM, JSON.stringify(bpms))
    this.set({ bpms })
  }

  /** Beat-grid anchor (position of one beat, in seconds) the user marked for a streaming track. */
  anchor(ref: string): number | null {
    return read(LS_GRID)[ref] ?? null
  }

  rememberAnchor(ref: string, anchor: number | null): void {
    const all = read(LS_GRID)
    if (anchor === null) delete all[ref]
    else all[ref] = anchor
    localStorage.setItem(LS_GRID, JSON.stringify(all))
  }

  private chain: Promise<void> = Promise.resolve()
  private tried = new Set<string>()

  /**
   * Find the BPM online from the track's title (and channel/artist name). Runs one lookup at a
   * time; a track is tried once per session unless `force` is set.
   */
  lookup(ref: string, title: string, author = '', force = false): void {
    if (this.state.bpms[ref] || this.state.looking.includes(ref)) return
    if (this.tried.has(ref) && !force) return
    this.tried.add(ref)
    this.set({ looking: [...this.state.looking, ref], failed: this.state.failed.filter((r) => r !== ref) })
    this.chain = this.chain.then(async () => {
      const result = await findBpm(title, author).catch(() => null)
      const looking = this.state.looking.filter((r) => r !== ref)
      if (this.state.bpms[ref]) {
        this.set({ looking }) // the user tapped a BPM meanwhile: theirs wins
      } else if (result) {
        this.set({ looking })
        this.remember(ref, result.bpm)
        this.resultListeners.forEach((fn) => fn(ref, result.bpm))
      } else {
        this.set({ looking, failed: [...this.state.failed, ref] })
      }
    })
  }

  /** Fallback: ask the analyzer window to measure a YouTube track; `urgent` jumps its queue. */
  request(ref: string, urgent = false): void {
    if (!ref.startsWith('youtube:') || this.state.bpms[ref]) return
    const pending = this.state.pending.includes(ref) ? this.state.pending : [...this.state.pending, ref]
    this.set({ pending })
    if (this.state.analyzerOn) this.post({ type: 'analyze', refs: [ref], urgent })
  }

  onResult(fn: ResultListener): void {
    this.resultListeners.add(fn)
  }

  openAnalyzer(): void {
    window.open('/analyzer.html', ANALYZER_CHANNEL, 'popup,width=460,height=560')
  }

  private onMessage(m: AnalyzerMessage): void {
    if (m.type === 'status') {
      this.lastBeat = Date.now()
      if (m.active && !this.state.analyzerOn && this.state.pending.length) {
        this.post({ type: 'analyze', refs: this.state.pending, urgent: false })
      }
      if (m.active !== this.state.analyzerOn || m.current !== this.state.current) {
        this.set({ analyzerOn: m.active, current: m.active ? m.current : null })
      }
    } else if (m.type === 'result') {
      this.set({ pending: this.state.pending.filter((r) => r !== m.ref) })
      if (m.bpm) {
        this.remember(m.ref, m.bpm)
        this.resultListeners.forEach((fn) => fn(m.ref, m.bpm as number))
      }
    }
  }
}

export const bpmStore = new BpmStore()
