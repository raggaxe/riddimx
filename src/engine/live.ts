import { beatPhase, refineTempo, tempoFromEnvelope } from './analyze'

/**
 * BPM and beat grid measured from a deck's sound while it plays (desktop app, YouTube decks).
 *
 * Fed with loudness-envelope chunks plus the track position at that moment. Works on one steady
 * stretch of playback at a time: a seek, pause or tempo change starts a new stretch.
 *  - BPM: measured after 20 s and again at 30 s. A BPM that is already known (online lookup) is only
 *    fine-tuned (±1.5%), which is what keeps the grid from drifting.
 *  - grid: re-measured every 2 s from the last seconds heard, so it follows the music even when
 *    the BPM is slightly off or the track drifts.
 */
const KEEP_S = 30
const BPM_AT_S = [20, 30]
const BEAT_STRENGTH = 1.9 // below this the music has no beat steady enough to trust
const GRID_STRENGTH = 1.8
const GRID_EVERY_S = 2
const GRID_WINDOW_S = 12
const GRID_MIN_S = 6

export interface LiveResult {
  bpm?: number
  anchor?: number
}

export class LiveGrid {
  private buf: Float32Array
  private len = 0 // valid samples in buf (the most recent ones)
  private total = 0 // samples since the stretch began
  private rate = 1
  private origin = 0 // track position of sample 0 of the stretch (running average)
  private originCount = 0
  private bpmStage = 0
  private gridAt = 0
  private mine: number | null = null // BPM this analyser produced (may still be refined)
  private anchor: number | null = null
  private candidate: number | null = null

  private votes: number[] = [] // unconfirmed BPM measurements (see `confirm`)

  /**
   * @param confirm how many separate measurements must agree before a BPM found from scratch is
   *   believed. 1 for the deck's own sound; more for the double-speed scan, whose sound is less clear.
   */
  constructor(
    private envRate: number,
    private confirm = 1,
  ) {
    this.buf = new Float32Array(Math.ceil(KEEP_S * envRate))
  }

  /** Start a new stretch (playback was interrupted). */
  reset(): void {
    this.len = 0
    this.total = 0
    this.originCount = 0
    this.bpmStage = 0
    this.gridAt = 0
    this.candidate = null
  }

  /** New track: forget everything. */
  clear(): void {
    this.reset()
    this.mine = null
    this.anchor = null
    this.votes = []
  }

  /**
   * @param position track position (s) heard at the end of this chunk
   * @param rate playback rate (1 = original tempo)
   * @param bpm the deck's current BPM at original tempo, if any
   */
  feed(chunk: Float32Array, position: number, rate: number, bpm: number | null): LiveResult | null {
    const expected = this.origin + ((this.total + chunk.length) / this.envRate) * this.rate
    if (this.total > 0 && (rate !== this.rate || Math.abs(expected - position) > 0.15)) this.reset()
    this.rate = rate

    // Append, keeping only the most recent KEEP_S seconds.
    const cap = this.buf.length
    if (this.len + chunk.length > cap) {
      const drop = this.len + chunk.length - cap
      this.buf.copyWithin(0, drop, this.len)
      this.len -= drop
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    this.total += chunk.length

    // Each chunk gives one (noisy) reading of where the stretch began; average them.
    const reading = position - (this.total / this.envRate) * rate
    this.originCount = Math.min(this.originCount + 1, 40)
    this.origin += (reading - this.origin) / this.originCount

    const seconds = this.total / this.envRate
    const env = this.buf.subarray(0, this.len)
    const result: LiveResult = {}

    // After the planned measurements, keep trying every 10 s for as long as there is still no BPM
    // (a clip may open with a long intro that has no beat).
    const last = BPM_AT_S[BPM_AT_S.length - 1]
    const due =
      this.bpmStage < BPM_AT_S.length
        ? BPM_AT_S[this.bpmStage]
        : bpm === null
          ? last + (this.bpmStage - BPM_AT_S.length + 1) * 10
          : Infinity
    if (seconds >= due && this.confirm > 1 && bpm !== null) {
      // The less clear scan only ever supplies a missing BPM; it never touches one that exists.
      this.bpmStage++
    } else if (seconds >= due) {
      this.bpmStage++
      // Tempos below are as heard (track BPM × playback rate).
      let found: { bpm: number; strength: number } | null = null
      if (bpm !== null && bpm !== this.mine) {
        found = refineTempo(env, this.envRate, bpm * rate, 0.015)
      } else {
        // (The brute-force scanTempo suits whole files; on these short, live stretches it misleads.)
        const first = tempoFromEnvelope(env, this.envRate)
        if (first) found = refineTempo(env, this.envRate, first.bpm, 0.04)
      }
      if (found && found.strength >= BEAT_STRENGTH) {
        let value: number | null = found.bpm / rate
        if (bpm === null && this.confirm > 1) {
          // From scratch on unclear sound: wait until several measurements land on the same tempo.
          this.votes.push(value)
          const close = this.votes.filter((v) => Math.abs(v - value!) / value! < 0.006)
          value = close.length >= this.confirm ? close.sort((x, y) => x - y)[close.length >> 1] : null
        }
        if (value !== null) {
          value = Math.abs(value - Math.round(value)) < 0.08 ? Math.round(value) : Math.round(value * 10) / 10
          if (value !== bpm) {
            this.mine = value
            result.bpm = value
            bpm = value
          }
        }
      }
    }

    if (bpm && seconds >= GRID_MIN_S && seconds - this.gridAt >= GRID_EVERY_S) {
      this.gridAt = seconds
      const window = env.subarray(Math.max(0, this.len - Math.ceil(GRID_WINDOW_S * this.envRate)))
      const period = (60 / (bpm * rate)) * this.envRate
      const phase = beatPhase(window, period)
      const beat = 60 / bpm
      const windowStart = this.origin + ((this.total - window.length) / this.envRate) * rate
      const toPosition = (offset: number): number => {
        const p = windowStart + (offset / this.envRate) * rate
        return p + Math.round((position - p) / beat) * beat // the beat nearest to "now"
      }
      let offset = phase.offset
      let strength = phase.strength
      let follows = false
      if (this.anchor !== null) {
        // Prefer staying on the grid we already have: look for the best fit within ±20 ms of it,
        // and only consider moving elsewhere when another alignment is clearly stronger.
        const steps = phase.all.length
        const current = ((((this.anchor - windowStart) / rate) * this.envRate) % period + period) % period
        const reach = Math.ceil(0.02 * this.envRate)
        let near = -1
        for (let d = -reach; d <= reach; d++) {
          const i = (((Math.round(current) + d) % steps) + steps) % steps
          if (near < 0 || phase.all[i] > phase.all[near]) near = i
        }
        if (phase.all[near] >= GRID_STRENGTH * 0.8 && phase.strength < phase.all[near] * 1.25) {
          offset = near
          strength = Math.max(phase.all[near], GRID_STRENGTH)
          follows = true
        }
      }
      if (strength >= GRID_STRENGTH) {
        const next = this.settle(toPosition(offset), beat, follows)
        if (next !== null) {
          this.anchor = next
          result.anchor = next
        }
      }
    }
    return result.bpm !== undefined || result.anchor !== undefined ? result : null
  }

  /** Small corrections are blended in; a big jump must be measured twice in a row before it is believed. */
  private settle(found: number, beat: number, follows: boolean): number | null {
    const gap = (a: number, b: number): number => {
      const d = (((a - b) / beat) % 1 + 1.5) % 1 - 0.5
      return d * beat
    }
    if (this.anchor === null) return found
    const diff = gap(found, this.anchor)
    if (follows || Math.abs(diff) < 0.03) {
      this.candidate = null
      return found - diff * 0.6 // move 40% of the way
    }
    if (this.candidate !== null && Math.abs(gap(found, this.candidate)) < 0.02) {
      this.candidate = null
      return found
    }
    this.candidate = found
    return null
  }
}
