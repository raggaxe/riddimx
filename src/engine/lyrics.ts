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
    super({ lines: {}, source: {}, working: {}, lang, model: 'checking', modelProgress: 0, modelSizeMb: 547, modelError: null })
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
    return this.state.lines[key]?.[0]?.time ?? null
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

  private lookupOnce(key: string, title: string, artist: string, duration: number): Promise<LyricLine[]> {
    const job = this.lookup(key, title, artist, duration)
    this.asked.set(key, job)
    return job
  }

  /** Lines for a track, or null while unknown. Starts the lookup the first time it is asked. */
  get linesFor(): (key: string, title: string, artist: string, duration: number) => LyricLine[] | null {
    return (key, title, artist, duration) => {
      const known = this.state.lines[key]
      if (known) return known
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
