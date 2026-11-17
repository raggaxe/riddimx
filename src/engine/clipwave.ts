import { mixer } from './mixer'
import { tapEnvelope } from './envelope'
import { RemotePlayer, desktop } from './ytremote'
import { LiveChroma } from './key'

/**
 * Waveform of a YouTube clip (desktop app only), built from sound instead of a file:
 *  - a hidden second player runs through the clip at double speed, silently, so the waveform
 *    is drawn ahead of where the deck is playing;
 *  - whatever the deck itself plays is added too.
 * The scan's sound is also handed to the deck (onScan) for BPM / beat-grid detection.
 * Finished waveforms are kept in localStorage, so a clip is only scanned once.
 */
const BUCKETS = 1000
const KEY = 'vx_wave:'
const FINE_KEY = 'vx_wavef:'
/** Peaks per second of clip kept for the zoomed, scrolling waveform. */
export const FINE_RATE = 50
export const SCAN_SPEED = 2
const SILENT = 1e-4 // "heard, and it was silence" (0 means not heard yet)

export class ClipWave {
  dirty = false
  private raw = new Float32Array(BUCKETS)
  private fine = new Float32Array(0) // FINE_RATE peaks per second, same scale as raw
  private fineSaved: string | null = null
  private ref: string | null = null
  private duration = 0
  private complete = false
  private scanner: RemotePlayer | null = null
  private scanReady = false
  private scanRate = 0 // envelope samples per second of the scanner's sound
  private scanVideo: string | null = null // clip being scanned
  private wanted: string | null = null // clip to scan once its duration is known
  private scanChroma: LiveChroma | null = null // notes heard by the scan, for the clip's musical key

  /**
   * @param onScan every slice of sound the look-ahead scan hears (same arguments as add()),
   *   so the deck can also measure BPM and beat grid before the clip is played
   */
  constructor(
    private deckName: string,
    private onScan?: (chunk: Float32Array, envRate: number, position: number, rate: number) => void,
  ) {}

  /** A clip was loaded: start from its saved waveform, if any. */
  open(ref: string, videoId: string): void {
    this.close()
    this.ref = ref
    this.wanted = videoId
    this.raw.fill(0)
    this.fine = new Float32Array(0)
    this.scanChroma?.chroma.clear()
    this.complete = false
    try {
      const saved = localStorage.getItem(KEY + ref)
      this.fineSaved = localStorage.getItem(FINE_KEY + ref)
      if (saved) {
        // Only "complete" when the fine waveform was saved too; otherwise the clip is scanned again.
        this.complete = saved[0] === 'c' && !!this.fineSaved
        const bytes = atob(saved.slice(1))
        for (let i = 0; i < BUCKETS && i < bytes.length; i++) {
          const q = bytes.charCodeAt(i)
          this.raw[i] = q ? Math.max(SILENT, q / 360) : 0
        }
      }
    } catch {
      /* unreadable cache: scan again */
    }
    this.dirty = true
  }

  /** The clip left the deck. */
  close(): void {
    if (this.ref) this.save()
    if (this.scanVideo && this.scanReady) this.scanner?.stopVideo()
    this.scanVideo = null
    this.wanted = null
    this.ref = null
    this.duration = 0
  }

  /** Length is known: buckets can be placed, and the look-ahead scan can start. */
  setDuration(duration: number): void {
    this.duration = duration
    this.fine = new Float32Array(Math.ceil(duration * FINE_RATE))
    if (this.fineSaved) {
      try {
        const bytes = atob(this.fineSaved)
        for (let i = 0; i < this.fine.length && i < bytes.length; i++) {
          const q = bytes.charCodeAt(i)
          this.fine[i] = q ? Math.max(SILENT, q / 360) : 0
        }
      } catch {
        /* unreadable: rebuilt by the scan */
      }
      this.fineSaved = null
      this.dirty = true
    }
    if (!desktop || this.complete || !this.wanted || this.scanVideo === this.wanted) return
    this.scanVideo = this.wanted
    if (!this.scanner) {
      const host = document.createElement('div')
      // Invisible but inside the window: a page that is never painted cannot be captured.
      host.style.cssText = 'position:fixed;left:0;bottom:0;width:320px;height:180px;opacity:0;pointer-events:none;z-index:-1'
      document.body.appendChild(host)
      this.scanner = new RemotePlayer(
        host,
        this.deckName + '-scan',
        {
          onReady: () => {
            this.scanReady = true
            this.kick()
          },
          onStateChange: (e) => {
            if (e.data === 1 && this.scanner!.getPlaybackRate() !== SCAN_SPEED) this.scanner!.setPlaybackRate(SCAN_SPEED)
            if (e.data === 0 && this.scanVideo && this.scanner!.getVideoData().video_id === this.scanVideo) {
              this.complete = true
              this.scanVideo = null
              this.save()
            }
          },
          onError: () => {
            this.scanVideo = null
          },
          onPlaybackRateChange: () => undefined,
        },
        (stream) => {
          this.scanChroma = new LiveChroma(mixer.ctx, mixer.ctx.createMediaStreamSource(stream))
          void tapEnvelope(mixer.ctx, stream, (chunk) => this.onScanChunk(chunk)).then((tap) => {
            this.scanRate = tap.rate
          })
        },
      )
    } else if (this.scanReady) this.kick()
  }

  private kick(): void {
    if (!this.scanner || !this.scanVideo) return
    this.scanner.cueVideoById(this.scanVideo)
    this.scanner.setPlaybackRate(SCAN_SPEED)
    this.scanner.playVideo()
  }

  private onScanChunk(chunk: Float32Array): void {
    const s = this.scanner
    if (!s || !this.scanVideo || !this.scanRate || s.getPlayerState() !== 1) return
    if (s.getVideoData().video_id !== this.scanVideo) return
    const position = s.getCurrentTime()
    const rate = s.getPlaybackRate()
    this.scanChroma?.sample() // YouTube keeps the pitch at double speed, so the notes are the real ones
    this.add(chunk, this.scanRate, position, rate)
    this.onScan?.(chunk, this.scanRate, position, rate)
  }

  /**
   * Add a slice of loudness envelope.
   * @param envRate envelope samples per second
   * @param position clip position (s) at the end of the slice
   * @param rate playback speed while it was heard
   */
  add(chunk: Float32Array, envRate: number, position: number, rate: number): void {
    if (!this.duration || !envRate) return
    const n = chunk.length
    for (let i = 0; i < n; i++) {
      const at = position - ((n - i) / envRate) * rate
      const bucket = Math.floor((at / this.duration) * BUCKETS)
      if (bucket < 0 || bucket >= BUCKETS) continue
      const v = Math.max(SILENT, chunk[i])
      const f = Math.floor(at * FINE_RATE)
      if (f >= 0 && f < this.fine.length && v > this.fine[f]) this.fine[f] = v
      if (v > this.raw[bucket]) {
        this.raw[bucket] = v
        this.dirty = true
      }
    }
  }

  /** Peaks scaled to 0..1 for drawing (0 = not heard yet), or null when nothing is known. */
  peaks(): Float32Array | null {
    let top = 0
    for (let i = 0; i < BUCKETS; i++) if (this.raw[i] > top) top = this.raw[i]
    if (top <= SILENT) return null
    top = Math.max(top, 0.05)
    const out = new Float32Array(BUCKETS)
    for (let i = 0; i < BUCKETS; i++) out[i] = this.raw[i] / top
    return out
  }

  /** Fine waveform (FINE_RATE peaks per second, 0 = not heard yet) and the level that should draw as full height. */
  detail(): { data: Float32Array; rate: number; top: number } | null {
    if (!this.fine.length) return null
    let top = 0.05
    for (let i = 0; i < BUCKETS; i++) if (this.raw[i] > top) top = this.raw[i]
    return { data: this.fine, rate: FINE_RATE, top }
  }

  /** Musical key heard by the scan so far, and how many readings it rests on. */
  scanKey(): { key: string | null; frames: number } {
    const chroma = this.scanChroma?.chroma
    return { key: chroma?.key() ?? null, frames: chroma?.frames ?? 0 }
  }

  /** Share of the clip whose waveform is known, 0..1. */
  get coverage(): number {
    let known = 0
    for (let i = 0; i < BUCKETS; i++) if (this.raw[i] > 0) known++
    return known / BUCKETS
  }

  private save(): void {
    if (!this.ref || this.coverage === 0) return
    let bytes = ''
    for (let i = 0; i < BUCKETS; i++) {
      const v = this.raw[i]
      bytes += String.fromCharCode(v > 0 ? Math.min(255, Math.max(1, Math.round(v * 360))) : 0)
    }
    try {
      if (this.complete && this.fine.length) {
        let fineBytes = ''
        for (let i = 0; i < this.fine.length; i++) {
          const v = this.fine[i]
          fineBytes += String.fromCharCode(v > 0 ? Math.min(255, Math.max(1, Math.round(v * 360))) : 0)
        }
        localStorage.setItem(FINE_KEY + this.ref, btoa(fineBytes))
      }
      localStorage.setItem(KEY + this.ref, (this.complete ? 'c' : 'p') + btoa(bytes))
    } catch {
      /* storage full: the waveform is simply rebuilt next time */
    }
  }
}
