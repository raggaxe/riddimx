import { Store } from '../store'
import { parseTitle } from './lookup'
import { desktop } from './ytremote'

/**
 * Time-synced lyrics for the scrolling waveform. First from the public LRCLIB catalogue (only the
 * song's artist and title are sent); for files it does not know, transcribed on this Mac by
 * whisper.cpp from the vocal stem. Results are remembered per track.
 */
export interface LyricLine {
  time: number // seconds
  text: string
}

interface LyricsState {
  /** key → lines (empty array = looked up, none found) */
  lines: Record<string, LyricLine[]>
  /** key → where the lines came from */
  source: Record<string, 'catalogue' | 'mac'>
  /** deck name → transcription progress 0..1, while one runs */
  working: Record<string, number>
  // The transcription model on this Mac: 'none' (no desktop app / no engine), 'missing' (not downloaded yet),
  // 'installing' (downloading: modelProgress 0..1), 'ready'.
  model: 'checking' | 'none' | 'missing' | 'installing' | 'ready'
  modelProgress: number
  modelSizeMb: number
  modelError: string | null
  /** language the songs are sung in, for the transcription */
  lang: LyricsLang
  /** key → seconds the lines are moved by (found by listening to the voice, or set by hand) */
  offset: Record<string, number>
  /** key → how the timing was set: 'auto' (lined up with the voice) or 'hand' (the DJ's nudges win) */
  fit: Record<string, 'auto' | 'hand'>
}

export type LyricsLang = 'pt' | 'en' | 'es' | 'auto'
export const LYRICS_LANGS: { id: LyricsLang; label: string }[] = [
  { id: 'pt', label: 'Português' },
  { id: 'en', label: 'Inglês / patois' },
  { id: 'es', label: 'Espanhol' },
  { id: 'auto', label: 'Detetar' },
]
const LS_LANG = 'vx_lyrics_lang'
const SRC = 'vx_lyr_src:'

const KEY = 'vx_lyr:'
const OFF = 'vx_lyr_off:' // { offset, fit }

function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = []
  for (const row of lrc.split('\n')) {
    const m = row.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/)
    if (m && m[3].trim()) out.push({ time: Number(m[1]) * 60 + Number(m[2]), text: m[3].trim() })
  }
  return out
}

class Lyrics extends Store<LyricsState> {
  private asked = new Map<string, Promise<LyricLine[]>>()

  constructor() {
    let lang: LyricsLang = 'pt'
    try {
      const saved = localStorage.getItem(LS_LANG) as LyricsLang | null
      if (saved && LYRICS_LANGS.some((l) => l.id === saved)) lang = saved
    } catch {
      /* default */
    }
    super({
      lines: {},
      source: {},
      working: {},
      lang,
      model: 'checking',
      modelProgress: 0,
      modelSizeMb: 547,
      modelError: null,
      offset: {},
      fit: {},
    })
    void this.checkModel()
  }

  private async checkModel(): Promise<void> {
    const m = await desktop?.lyricsModel?.().catch(() => null)
    if (!m || !m.bin) return this.set({ model: 'none' })
    this.set({ model: m.ready ? 'ready' : 'missing', modelSizeMb: m.sizeMb })
  }

  /** Downloads the transcription model (asked from the DJ's button), then the decks loaded next get lyrics. */
  async installModel(): Promise<void> {
    if (!desktop?.lyricsInstall || this.state.model === 'installing' || this.state.model === 'ready') return
    this.set({ model: 'installing', modelProgress: 0, modelError: null })
    const stop = desktop.onLyricsInstallProgress?.((p) => this.set({ modelProgress: p }))
    try {
      await desktop.lyricsInstall()
      this.set({ model: 'ready', modelProgress: 1 })
    } catch (e) {
      this.set({
        model: 'missing',
        modelError: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''),
      })
    } finally {
      stop?.()
    }
  }

  setLang(lang: LyricsLang): void {
    this.set({ lang })
    try {
      localStorage.setItem(LS_LANG, lang)
    } catch {
      /* not remembered */
    }
  }

  /** Lyrics text remembered for a track (for searching the library), '' if none. */
  textFor(key: string): string {
    const known = this.state.lines[key]
    if (known) return known.map((l) => l.text).join(' ')
    try {
      const cached = localStorage.getItem(KEY + key)
      return cached ? (JSON.parse(cached) as LyricLine[]).map((l) => l.text).join(' ') : ''
    } catch {
      return ''
    }
  }

  /** First sung line: where the voice comes in. */
  vocalIn(key: string): number | null {
    const first = this.state.lines[key]?.[0]
    return first ? first.time + this.offsetOf(key) : null
  }

  // ───────────── timing: lines moved to where the voice really sings them ─────────────

  private shifted = new Map<string, { from: LyricLine[]; by: number; lines: LyricLine[] }>()

  offsetOf(key: string): number {
    if (!(key in this.state.offset)) {
      // Remembered from an earlier session (read once, then kept in the state).
      try {
        const saved = JSON.parse(localStorage.getItem(OFF + key) || 'null') as { offset: number; fit: 'auto' | 'hand' } | null
        if (saved && Number.isFinite(saved.offset)) {
          this.state.offset[key] = saved.offset
          this.state.fit[key] = saved.fit
          return saved.offset
        }
      } catch {
        /* none */
      }
      return 0
    }
    return this.state.offset[key]
  }

  private setOffset(key: string, offset: number, fit: 'auto' | 'hand'): void {
    const value = Math.round(offset * 100) / 100
    this.set({ offset: { ...this.state.offset, [key]: value }, fit: { ...this.state.fit, [key]: fit } })
    try {
      localStorage.setItem(OFF + key, JSON.stringify({ offset: value, fit }))
    } catch {
      /* not remembered */
    }
  }

  /** The DJ moves the lyrics earlier (negative) or later; from then on the automatic fit leaves them alone. */
  nudge(key: string, seconds: number): void {
    this.setOffset(key, this.offsetOf(key) + seconds, 'hand')
  }

  /** Back to the automatic timing (fitted again the next time the track loads). */
  resetTiming(key: string): void {
    this.setOffset(key, 0, 'auto')
    try {
      localStorage.removeItem(OFF + key)
    } catch {
      /* fine */
    }
  }

  /**
   * Lines up the lyrics with the singing: the catalogue's lines may come from another version of the
   * song (a longer intro, a radio edit) and the transcription's from a slightly early segment start.
   * `voice` is the vocal stem when there is one (`clean`), else the whole track. Finds the one shift
   * that puts the most line starts where a voice starts; kept only when it clearly beats the others.
   */
  async align(key: string, voice: AudioBuffer, clean: boolean): Promise<void> {
    this.offsetOf(key) // loads what was remembered
    if (this.state.fit[key] === 'hand') return
    const lines = this.state.lines[key]
    if (!lines || lines.length < 4) return
    const env = await voiceActivity(voice, clean)
    const shift = bestShift(
      env,
      lines.map((l) => l.time),
    )
    if (shift !== null) this.setOffset(key, shift, 'auto')
  }

  private keep(key: string, lines: LyricLine[], source: 'catalogue' | 'mac'): void {
    try {
      localStorage.setItem(KEY + key, JSON.stringify(lines))
      if (lines.length) localStorage.setItem(SRC + key, source)
    } catch {
      /* not remembered */
    }
    this.set({ lines: { ...this.state.lines, [key]: lines }, source: { ...this.state.source, [key]: source } })
  }

  /**
   * A file's lyrics when the catalogue has none: transcribed from `voice` (the vocal stem, or the
   * whole track) at 16 kHz mono. `deck` only labels the progress in the top bar.
   */
  async fromAudio(
    key: string,
    title: string,
    artist: string,
    duration: number,
    id: string,
    voice: AudioBuffer,
    deck: string,
  ): Promise<void> {
    if (!desktop?.transcribe || !(await desktop.lyricsAvailable?.())) return
    const online = await (this.asked.get(key) ?? this.lookupOnce(key, title, artist, duration))
    if (online.length) return
    const lang = this.state.lang
    const cached = await desktop.lyricsCached?.(id, lang)
    if (cached) return this.keep(key, cached, 'mac')
    this.set({ working: { ...this.state.working, [deck]: 0 } })
    const stop = desktop.onLyricsProgress?.((job, p) => {
      if (job === id) this.set({ working: { ...this.state.working, [deck]: p } })
    })
    try {
      const pcm = await to16kMono(voice)
      const lines = await desktop.transcribe(id, pcm, lang)
      if (lines) this.keep(key, lines, 'mac')
    } catch (e) {
      console.warn('transcription failed', e)
    } finally {
      stop?.()
      const working = { ...this.state.working }
      delete working[deck]
      this.set({ working })
    }
  }

  /** Waits for the catalogue lookup of a track (started here if nobody asked yet). */
  async linesReady(key: string, title: string, artist: string, duration: number): Promise<void> {
    if (this.state.lines[key]) return
    await (this.asked.get(key) ?? this.lookupOnce(key, title, artist, duration))
  }

  private lookupOnce(key: string, title: string, artist: string, duration: number): Promise<LyricLine[]> {
    const job = this.lookup(key, title, artist, duration)
    this.asked.set(key, job)
    return job
  }

  /** Lines for a track (at their fitted time), or null while unknown. Starts the lookup the first time it is asked. */
  get linesFor(): (key: string, title: string, artist: string, duration: number) => LyricLine[] | null {
    return (key, title, artist, duration) => {
      const known = this.state.lines[key]
      if (known) {
        const by = this.offsetOf(key)
        if (!by) return known
        const memo = this.shifted.get(key)
        if (memo && memo.from === known && memo.by === by) return memo.lines
        const lines = known.map((l) => ({ time: l.time + by, text: l.text }))
        this.shifted.set(key, { from: known, by, lines })
        return lines
      }
      if (!this.asked.has(key) && title) void this.lookupOnce(key, title, artist, duration)
      return null
    }
  }

  private async lookup(key: string, title: string, artist: string, duration: number): Promise<LyricLine[]> {
    let lines: LyricLine[] = []
    try {
      const cached = localStorage.getItem(KEY + key)
      if (cached) lines = JSON.parse(cached)
      else {
        const parsed = parseTitle(title, artist)
        if (parsed.track) {
          const query = new URLSearchParams({ track_name: parsed.track, artist_name: parsed.artist })
          const res = await fetch('https://lrclib.net/api/search?' + query)
          const found: { syncedLyrics?: string; duration?: number }[] = res.ok ? await res.json() : []
          // Prefer the version whose length matches this track (same recording, so the timing fits).
          const synced = found.filter((f) => f.syncedLyrics)
          synced.sort((a, b) => Math.abs((a.duration || 0) - duration) - Math.abs((b.duration || 0) - duration))
          if (synced[0]?.syncedLyrics) lines = parseLrc(synced[0].syncedLyrics)
        }
        localStorage.setItem(KEY + key, JSON.stringify(lines))
      }
    } catch {
      this.asked.delete(key) // network trouble: allow another try later
      return []
    }
    let source: 'catalogue' | 'mac' = 'catalogue'
    try {
      if (localStorage.getItem(SRC + key) === 'mac') source = 'mac'
    } catch {
      /* catalogue */
    }
    this.set({ lines: { ...this.state.lines, [key]: lines }, source: { ...this.state.source, [key]: source } })
    return lines // lines found earlier by the transcription count too, so it is not redone
  }
}

const FRAME = 0.02 // seconds per step of the voice activity

/**
 * How much voice there is, every 20 ms, 0..1. From the whole track only the voice's band (250 Hz–3.5 kHz)
 * of the centre is kept, where the singer usually sits.
 */
async function voiceActivity(buffer: AudioBuffer, clean: boolean): Promise<Float32Array> {
  const rate = 8000
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * rate), rate)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  let node: AudioNode = src
  if (!clean) {
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 250
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 3500
    node = node.connect(hp).connect(lp)
  }
  node.connect(ctx.destination)
  src.start()
  const pcm = (await ctx.startRendering()).getChannelData(0)
  const hop = Math.round(rate * FRAME)
  const n = Math.floor(pcm.length / hop)
  const db = new Float32Array(n)
  for (let f = 0; f < n; f++) {
    let sum = 0
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += pcm[i] * pcm[i]
    db[f] = 10 * Math.log10(sum / hop + 1e-10)
  }
  // Scaled between the quiet and the loud parts of this track, so the level of the file does not matter.
  const sorted = Float32Array.from(db).sort()
  const lo = sorted[Math.floor(n * 0.2)]
  const hi = sorted[Math.floor(n * 0.97)]
  const act = new Float32Array(n)
  for (let f = 0; f < n; f++) act[f] = Math.min(1, Math.max(0, (db[f] - lo) / Math.max(6, hi - lo)))
  return act
}

/**
 * The shift (seconds, ±25) that best puts the line starts on voice coming in: voice just after each start,
 * less just before it. Null when no shift stands out (no clear voice, or the lines fit already).
 */
function bestShift(act: Float32Array, starts: number[]): number | null {
  const n = act.length
  const sum = new Float64Array(n + 1)
  for (let i = 0; i < n; i++) sum[i + 1] = sum[i] + act[i]
  const mean = (a: number, b: number): number => {
    const x = Math.max(0, Math.min(n, a))
    const y = Math.max(0, Math.min(n, b))
    return y > x ? (sum[y] - sum[x]) / (y - x) : 0
  }
  const W = Math.round(0.5 / FRAME)
  const score = (shift: number): number => {
    let s = 0
    for (const t of starts) {
      const f = Math.round((t + shift) / FRAME)
      s += mean(f, f + W) - mean(f - W, f)
    }
    return s / starts.length
  }
  const range = Math.round(25 / FRAME)
  const scores = new Float64Array(2 * range + 1)
  let best = 0
  for (let k = -range; k <= range; k++) {
    scores[k + range] = score(k * FRAME)
    if (scores[k + range] > scores[best]) best = k + range
  }
  const sorted = Float64Array.from(scores).sort()
  const median = sorted[range]
  const spread = sorted[Math.floor(sorted.length * 0.9)] - median
  const top = scores[best]
  // Must stand clear of the crowd, and beat leaving the lines where they are by a margin.
  if (top <= 0 || top - median < 3 * Math.max(spread, 0.01) || top - scores[range] < 0.04) return null
  return (best - range) * FRAME
}

/** What whisper reads: one channel at 16 kHz. */
async function to16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * 16000), 16000)
  const src = ctx.createBufferSource()
  src.buffer = buffer
  src.connect(ctx.destination)
  src.start()
  const out = (await ctx.startRendering()).getChannelData(0)
  // Quiet vocal stems are lifted to full level: whisper hears faint singing much better then.
  let peak = 0
  for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]))
  if (peak > 0 && peak < 0.9) for (let i = 0; i < out.length; i++) out[i] *= 0.9 / peak
  return out
}

export const lyrics = new Lyrics()
