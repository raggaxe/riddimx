/* eslint-disable @typescript-eslint/no-explicit-any */
import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { computeDetail, computePeaks, detectBeatAnchor, detectBpm } from './analyze'
import { loadYT } from './youtube'
import { CAPTURE_LATENCY, RemotePlayer, desktop } from './ytremote'
import { tapEnvelope } from './envelope'
import { LiveGrid } from './live'
import { ClipWave, SCAN_SPEED } from './clipwave'
import { FxUnit, type FxType } from './fx'
import { LiveChroma, detectKey, keyStore, transpose } from './key'
import { KEYLOCK_LATENCY, createPitchShifter, setPitch } from './keylock'
import { coverOf } from './cover'
import { Tape } from './tape'
import { dubSettings } from './dub'
import { rewindSettings } from './rewind'
import { lyrics } from './lyrics'
import { sampler } from './sampler'
import { spotify, type SpotifyOwner } from './spotify'
import { bpmStore } from './bpm'
import { separateStems, SAMPLE_RATE } from './ai/stems'
import { ALL_STEMS, STEMS, createStems, setStems, type Stem, type StemState } from './stems'

type AiPart = 'vocals' | 'drums' | 'bass' | 'other'
const AI_PARTS: AiPart[] = ['vocals', 'drums', 'bass', 'other']

export type SourceKind = 'none' | 'local' | 'youtube' | 'spotify'
export type EqBand = 'low' | 'mid' | 'high'
export type MetaCallback = (title: string, artist: string) => void

export interface DeckState {
  kind: SourceKind
  title: string
  artist: string
  duration: number
  playing: boolean
  loading: boolean
  error: string | null
  rate: number // 1 = original tempo
  volume: number // 0..1
  low: number // -1..1
  mid: number
  high: number
  filter: number // -1 low-pass … 0 off … 1 high-pass
  bpm: number | null // at original tempo
  ref: string | null // streaming track key ("youtube:<id>"), used to remember its BPM
  anchor: number | null // beat grid: position (s) of one beat; null = grid unknown
  syncOn: boolean // following the other deck's tempo and beat phase
  blocked: boolean // YouTube refuses to play this video outside youtube.com
  cue: number
  hotcues: (number | null)[]
  loop: { in: number; out: number; beats: number } | null
  peaks: Float32Array | null
  stems: StemState // false = that part of the music is muted
  processed: boolean // desktop app: YouTube sound runs through this deck's EQ, filter and stems
  pfl: boolean // pre-listen: this deck is sent to the headphones, whatever its fader says
  gain: number // channel trim, -1..1 (= -12..+12 dB)
  fx: FxType
  fxOn: boolean
  fxAmount: number // 0..1
  key: string | null // musical key, e.g. "A#m"
  keyLock: boolean // files: tempo changes keep the original pitch (YouTube always does)
  loopIn: number | null // manual loop: start marked, waiting for the end
  cover: string | null // picture embedded in the file
  dubbing: boolean
  aiStems: 'off' | 'working' | 'ready' | 'error' // files, desktop app: stems separated by the Demucs model
  aiProgress: number // 0..1 while the separation runs
}

const YT_UNSTARTED = -1
const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_CUED = 5

/**
 * One deck with three interchangeable sources:
 *  - local file: full Web Audio chain (EQ, filter, tempo, waveform, sample-accurate loops)
 *  - YouTube: official IFrame player (transport, volume, tempo; no access to raw audio)
 *  - Spotify: Web Playback SDK (transport and volume only)
 */
export class Deck extends Store<DeckState> implements SpotifyOwner {
  private readonly input: GainNode
  private stemsNode: AudioWorkletNode | null = null
  private pflSend: GainNode // post-effect, pre-fader tap to the headphone bus
  private fxUnit: FxUnit
  private srcBus: GainNode // file playback enters here; routed straight on, or through the pitch shifter
  private pitchNode: AudioWorkletNode | null = null
  private liveKey: LiveChroma | null = null // notes of the YouTube clip as it plays
  private keyKnown = false // key came from memory: do not re-guess it
  private rewinding = false
  private tape: Tape // last seconds heard, for the rewind
  private live: LiveGrid | null = null // desktop app: BPM / beat grid measured from the YouTube sound
  private liveRate = 0 // envelope samples per second of that sound
  private wave: ClipWave // desktop app: waveform of the YouTube clip
  private ticks = 0
  private localDetail: Float32Array | null = null // fine waveform of the loaded file
  private scanGrid: LiveGrid | null = null // BPM / beat grid from the look-ahead scan, before the clip plays
  private scanAnchors: number[] = [] // beats found by the scan along the clip, in clip order
  private readonly eq: Record<EqBand, BiquadFilterNode>
  private readonly filterNode: BiquadFilterNode
  private readonly vol: GainNode
  private readonly xfade: GainNode

  private token = 0
  private metaCb: MetaCallback | null = null
  private bend = 1
  private taps: number[] = []
  private tapPositions: number[] = []
  private syncMaster: Deck | null = null
  private ytApplied = 1 // rate last sent to the YouTube player while sync drives it
  private ytSwitchedAt = 0
  private bpmTrusted = false // remembered, tapped or corrected by the user: analysis results leave it alone

  // local
  private buffer: AudioBuffer | null = null
  private src: AudioBufferSourceNode | null = null
  private extra: AudioBufferSourceNode[] = [] // the other AI stems, started together with src
  private stemBuffers: Record<AiPart, AudioBuffer> | null = null
  private aiIn!: Record<AiPart, GainNode> // where each AI stem source plugs in
  private aiOut!: Record<Stem, GainNode> // one level per stem pad
  private fileId: string | null = null
  private anchorTime = 0
  private anchorOffset = 0

  // youtube
  private ytHost: HTMLElement | null = null
  private yt: any = null
  private ytReady = false
  private ytState = YT_UNSTARTED
  private ytWanted = ''
  private ytPending: number | null = null

  // spotify
  private spUri = ''
  private spStarted = false
  private spPos = 0
  private spPosAt = 0

  constructor(
    readonly side: 0 | 1,
    readonly name: string,
  ) {
    super({
      kind: 'none',
      title: '',
      artist: '',
      duration: 0,
      playing: false,
      loading: false,
      error: null,
      rate: 1,
      volume: 0.8,
      low: 0,
      mid: 0,
      high: 0,
      filter: 0,
      bpm: null,
      ref: null,
      anchor: null,
      syncOn: false,
      blocked: false,
      cue: 0,
      hotcues: [null, null, null, null],
      loop: null,
      peaks: null,
      stems: { ...ALL_STEMS },
      processed: false,
      pfl: false,
      gain: 0,
      fx: 'echo',
      fxOn: false,
      fxAmount: 0.5,
      key: null,
      keyLock: false,
      loopIn: null,
      cover: null,
      dubbing: false,
      aiStems: 'off',
      aiProgress: 0,
    })
    this.wave = new ClipWave(name, (chunk, envRate, position, rate) => this.onScanChunk(chunk, envRate, position, rate))
    const ctx = mixer.ctx
    const band = (type: BiquadFilterType, freq: number): BiquadFilterNode => {
      const node = ctx.createBiquadFilter()
      node.type = type
      node.frequency.value = freq
      if (type === 'peaking') node.Q.value = 0.7
      return node
    }
    this.input = ctx.createGain()
    this.eq = { low: band('lowshelf', 250), mid: band('peaking', 1000), high: band('highshelf', 4000) }
    this.filterNode = ctx.createBiquadFilter()
    this.filterNode.type = 'allpass'
    this.vol = ctx.createGain()
    this.vol.gain.value = this.state.volume
    this.xfade = ctx.createGain()
    this.input.connect(this.eq.low)
    this.eq.low.connect(this.eq.mid)
    this.eq.mid.connect(this.eq.high)
    this.eq.high.connect(this.filterNode)
    this.srcBus = ctx.createGain()
    this.srcBus.connect(this.input)
    this.buildAiStems(ctx)
    void createPitchShifter(ctx)
      .then((node) => {
        this.pitchNode = node
        node.connect(this.input)
        this.routeSource()
      })
      .catch(() => undefined)
    this.fxUnit = new FxUnit(ctx)
    this.filterNode.connect(this.fxUnit.input)
    this.fxUnit.output.connect(this.vol)
    this.tape = new Tape(ctx, this.fxUnit.output)
    this.pflSend = ctx.createGain()
    this.pflSend.gain.value = 0
    this.fxUnit.output.connect(this.pflSend)
    this.pflSend.connect(mixer.cueBus)
    this.vol.connect(this.xfade)
    this.xfade.connect(mixer.masterGain)
    // The stem splitter loads asynchronously; until then the input feeds the EQ directly.
    void createStems(ctx)
      .then((node) => {
        this.stemsNode = node
        this.input.disconnect()
        this.input.connect(node)
        node.connect(this.eq.low)
        this.pushStems()
      })
      .catch(() => undefined)
    mixer.register(this)
    bpmStore.onResult((ref, bpm) => this.onAnalysed(ref, bpm))
    this.applyOutput()
    window.setInterval(() => this.tick(), 50)
  }

  // ───────────────────────── loading ─────────────────────────

  private unload(): void {
    this.token++
    this.metaCb = null
    if (this.state.cover) URL.revokeObjectURL(this.state.cover)
    this.wave.close()
    this.stopSource()
    this.buffer = null
    this.stemBuffers = null
    this.fileId = null
    this.localDetail = null
    this.anchorOffset = 0
    if (this.yt && this.ytReady) {
      try {
        this.yt.stopVideo()
      } catch {
        /* player already gone */
      }
    }
    this.ytPending = null
    if (spotify.owner === this) {
      spotify.player?.pause().catch(() => undefined)
      spotify.owner = null
    }
    this.spStarted = false
    this.spPos = 0
    this.bend = 1
    this.taps = []
    this.tapPositions = []
    this.syncMaster = null
    this.bpmTrusted = false
    this.set({
      kind: 'none',
      title: '',
      artist: '',
      duration: 0,
      playing: false,
      loading: false,
      error: null,
      rate: 1,
      bpm: null,
      key: null,
      loopIn: null,
      cover: null,
      ref: null,
      anchor: null,
      syncOn: false,
      blocked: false,
      cue: 0,
      hotcues: [null, null, null, null],
      loop: null,
      peaks: null,
      stems: { ...ALL_STEMS },
      aiStems: 'off',
      aiProgress: 0,
    })
    this.pushStems()
  }

  private fail(token: number, e: unknown): void {
    if (token !== this.token) return
    this.set({ loading: false, error: e instanceof Error ? e.message : String(e) })
  }

  /** Take the track off the deck. Only while stopped, so a playing track is never cut by accident. */
  eject(): void {
    if (this.state.playing || this.state.kind === 'none') return
    this.unload()
  }

  async loadFile(file: File): Promise<void> {
    this.unload()
    const token = this.token
    this.set({ kind: 'local', title: file.name.replace(/\.[^.]+$/, ''), loading: true })
    try {
      const bytes = await file.arrayBuffer()
      const fingerprint = crypto.subtle.digest('SHA-1', bytes) // copies the bytes now: decoding detaches them
      const cover = coverOf(bytes)
      const buffer = await mixer.ctx.decodeAudioData(bytes)
      if (token !== this.token) {
        if (cover) URL.revokeObjectURL(cover)
        return
      }
      this.buffer = buffer
      this.set({ cover })
      this.localDetail = computeDetail(buffer)
      void detectKey(buffer).then((key) => {
        if (token === this.token) this.set({ key })
      })
      const bpm = detectBpm(buffer)
      this.set({
        loading: false,
        duration: buffer.duration,
        peaks: computePeaks(buffer),
        bpm,
        anchor: bpm ? detectBeatAnchor(buffer, bpm) : null,
      })
      void this.loadAiStems(token, fingerprint).finally(() => this.autoLyrics(token, fingerprint))
    } catch {
      this.fail(token, new Error('Formato de áudio não suportado'))
    }
  }

  /** React hands us the element that will contain this deck's YouTube iframe. */
  attachHost(el: HTMLElement | null): void {
    if (el) this.ytHost = el
  }

  async loadYouTube(videoId: string, onMeta?: MetaCallback, known?: { title: string; artist: string }): Promise<void> {
    this.unload()
    const token = this.token
    this.metaCb = onMeta ?? null
    this.set({ kind: 'youtube', title: known?.title || 'YouTube ' + videoId, artist: known?.artist || '', loading: true })
    this.recall('youtube:' + videoId)
    if (desktop) {
      this.wave.open('youtube:' + videoId, videoId)
      this.set({ peaks: this.wave.peaks() })
    }
    if (known?.title) this.lookupBpm()
    try {
      const YT = desktop ? null : await loadYT()
      if (token !== this.token) return
      this.ytWanted = videoId
      if (this.yt) {
        if (this.ytReady) this.yt.cueVideoById(videoId)
        return // not ready yet: onReady cues ytWanted
      }
      if (!this.ytHost) throw new Error('Player do YouTube indisponível')
      const el = document.createElement('div')
      this.ytHost.appendChild(el)
      const events = {
        onReady: () => this.onYtReady(),
        onStateChange: (e: any) => this.onYtState(e.data),
        onError: (e: any) => this.onYtError(e.data),
        // YouTube snaps tempo to 0.05 steps: show the rate it actually applied.
        onPlaybackRateChange: (e: any) => {
          if (this.state.kind === 'youtube' && !this.state.syncOn && this.bend === 1 && e.data !== this.state.rate) {
            this.set({ rate: e.data })
          }
        },
      }
      if (desktop) {
        // Desktop app: the player sits in its own muted page and its sound comes back as a stream.
        this.yt = new RemotePlayer(el, this.name, events, (stream) => {
          const source = mixer.ctx.createMediaStreamSource(stream)
          source.connect(this.input)
          this.liveKey = new LiveChroma(mixer.ctx, source)
          this.set({ processed: true })
          void tapEnvelope(mixer.ctx, stream, (chunk) => this.onLiveChunk(chunk)).then((tap) => {
            this.liveRate = tap.rate
            this.live = new LiveGrid(tap.rate)
          })
        })
      } else {
        this.yt = new YT.Player(el, {
          width: '100%',
          height: '100%',
          videoId,
          playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
          events,
        })
      }
    } catch (e) {
      this.fail(token, e)
    }
  }

  async loadSpotify(trackId: string, onMeta?: MetaCallback): Promise<void> {
    this.unload()
    const token = this.token
    this.metaCb = onMeta ?? null
    this.set({ kind: 'spotify', title: 'Spotify', loading: true })
    this.recall('spotify:' + trackId)
    try {
      await spotify.getToken()
      await spotify.ensurePlayer()
      const track = await spotify.api('GET', '/tracks/' + trackId)
      if (token !== this.token) return
      const title: string = track.name
      const artist: string = (track.artists || []).map((a: any) => a.name).join(', ')
      this.spUri = 'spotify:track:' + trackId
      this.set({ loading: false, title, artist, duration: track.duration_ms / 1000 })
      this.metaCb?.(title, artist)
      if (this.state.ref && !this.state.bpm) bpmStore.lookup(this.state.ref, `${artist} - ${title}`, artist)
    } catch (e) {
      this.fail(token, e)
    }
  }

  // ───────────────────────── youtube events ─────────────────────────

  private onYtReady(): void {
    this.ytReady = true
    if (this.state.kind !== 'youtube') {
      this.yt.stopVideo()
      return
    }
    if (this.yt.getVideoData?.()?.video_id !== this.ytWanted) this.yt.cueVideoById(this.ytWanted)
    this.applyOutput()
    this.ytMeta()
    this.set({ loading: false })
  }

  private onYtState(state: number): void {
    this.ytState = state
    if (this.state.kind !== 'youtube') return
    if (state === YT_PLAYING) {
      this.pushRate()
      this.applyOutput()
      this.ytMeta()
      this.set({ playing: true, loading: false })
    } else if (state === YT_PAUSED || state === YT_ENDED) {
      this.set({ playing: false })
    } else if (state === YT_CUED) {
      this.ytMeta()
      this.set({ playing: false, loading: false })
    }
  }

  private onYtError(code: number): void {
    if (this.state.kind !== 'youtube') return
    const blocked = code === 101 || code === 150
    this.set({
      loading: false,
      playing: false,
      blocked,
      error: blocked ? 'O dono deste vídeo bloqueou a reprodução fora do youtube.com.' : 'Erro do YouTube (' + code + ')',
    })
  }

  private ytMeta(): void {
    const duration: number = this.yt.getDuration?.() || 0
    const data = this.yt.getVideoData?.() || {}
    const patch: Partial<DeckState> = {}
    if (duration && duration !== this.state.duration) {
      patch.duration = duration
      if (this.state.kind === 'youtube') this.wave.setDuration(duration)
    }
    if (data.title && data.title !== this.state.title) {
      patch.title = data.title
      patch.artist = data.author || ''
      this.metaCb?.(data.title, data.author || '')
    }
    if (Object.keys(patch).length) this.set(patch)
    if (patch.title) this.lookupBpm()
  }

  // ───────────────────────── spotify events ─────────────────────────

  onSpotifyState(s: any): void {
    if (!s || this.state.kind !== 'spotify') return
    this.spPos = s.position / 1000
    this.spPosAt = performance.now()
    this.set({ playing: !s.paused })
  }

  /** Another deck (or logout) took the single Spotify stream. */
  spotifyReleased(): void {
    this.spPos = this.getPosition()
    this.spStarted = false
    this.set({ playing: false })
  }

  // ───────────────────────── transport ─────────────────────────

  getPosition(): number {
    const s = this.state
    switch (s.kind) {
      case 'local': {
        if (this.scratchState) return this.scratchState.pos
        if (!this.src) return this.anchorOffset
        let pos = this.anchorOffset + (mixer.ctx.currentTime - this.anchorTime) * s.rate * this.bend
        if (s.loop && pos >= s.loop.out) pos = s.loop.in + ((pos - s.loop.in) % (s.loop.out - s.loop.in))
        return Math.min(pos, s.duration)
      }
      case 'youtube':
        if (this.ytPending !== null) return this.ytPending
        if (!this.ytReady) return 0
        // Through the desktop capture the sound is heard slightly after the player's own clock.
        return Math.max(
          0,
          (this.yt.getCurrentTime?.() || 0) - (this.state.processed && this.state.playing ? CAPTURE_LATENCY * this.state.rate : 0),
        )
      case 'spotify': {
        if (!this.spStarted || !s.playing) return this.spPos
        return Math.min(this.spPos + (performance.now() - this.spPosAt) / 1000, s.duration)
      }
      default:
        return 0
    }
  }

  private startSource(offset: number): void {
    if (!this.buffer) return
    const ctx = mixer.ctx
    const loop = this.state.loop
    const make = (buffer: AudioBuffer, to: AudioNode): AudioBufferSourceNode => {
      const n = ctx.createBufferSource()
      n.buffer = buffer
      n.playbackRate.value = this.state.rate * this.bend
      if (loop) {
        n.loop = true
        n.loopStart = loop.in
        n.loopEnd = loop.out
      }
      n.connect(to)
      return n
    }
    const stems = this.stemBuffers
    const node = stems ? make(stems.vocals, this.aiIn.vocals) : make(this.buffer, this.srcBus)
    this.extra = stems ? AI_PARTS.slice(1).map((part) => make(stems[part], this.aiIn[part])) : []
    const when = ctx.currentTime + (stems ? 0.01 : 0) // several sources: one shared start time keeps them locked
    node.onended = () => {
      if (this.src !== node) return
      this.src = null
      this.anchorOffset = 0
      this.set({ playing: false })
    }
    node.start(when, offset)
    for (const n of this.extra) n.start(when, offset)
    this.src = node
    this.anchorTime = when
    this.anchorOffset = offset
  }

  private stopSource(): void {
    const node = this.src
    if (!node) return
    this.src = null
    node.onended = null
    try {
      node.stop()
    } catch {
      /* never started */
    }
    node.disconnect()
    for (const n of this.extra) {
      try {
        n.stop()
      } catch {
        /* never started */
      }
      n.disconnect()
    }
    this.extra = []
  }

  private get sources(): AudioBufferSourceNode[] {
    return this.src ? [this.src, ...this.extra] : []
  }

  /**
   * The loaded file's audio, for cutting a piece out of it (the drop maker): the voice alone when the
   * AI stems are ready and `voiceOnly` is asked, else the whole track. Null for streams or an empty deck.
   */
  clipSource(voiceOnly: boolean): AudioBuffer | null {
    if (this.state.kind !== 'local' || !this.buffer) return null
    return voiceOnly && this.stemBuffers ? this.stemBuffers.vocals : this.buffer
  }

  /** This deck's sound after its fader and the crossfader: what the rack's echo throws take. */
  get sendTap(): AudioNode {
    return this.xfade
  }

  /**
   * The next beat of this track: real seconds until it, and one beat's length in real seconds.
   * Null while the tempo or the beat grid is unknown, or the deck is stopped.
   */
  nextBeat(): { wait: number; beat: number } | null {
    const s = this.state
    if (!s.bpm || s.anchor === null || !s.playing) return null
    const beat = 60 / s.bpm // in track seconds
    const since = (this.getPosition() - s.anchor) / beat
    const wait = ((Math.ceil(since) - since) * beat) / (s.rate || 1)
    return { wait: wait < 0.02 ? wait + beat / (s.rate || 1) : wait, beat: beat / (s.rate || 1) }
  }

  /** Freeze the current position as the new time anchor (before any tempo/loop change). */
  private reanchor(): void {
    if (!this.src) return
    this.anchorOffset = this.getPosition()
    this.anchorTime = mixer.ctx.currentTime
  }

  play(): void {
    const s = this.state
    if (s.loading || s.kind === 'none') return
    mixer.resume()
    if (s.kind === 'youtube' && !s.playing) this.useScanAnchor() // grid for where playback starts
    if (s.kind === 'local') {
      if (this.src || !this.buffer) return
      this.startSource(this.anchorOffset)
      this.set({ playing: true })
      this.syncJump()
    } else if (s.kind === 'youtube') {
      if (!this.ytReady) return
      if (this.ytPending !== null) {
        this.yt.seekTo(this.ytPending, true)
        this.ytPending = null
      }
      this.yt.playVideo()
    } else {
      void this.playSpotify()
    }
  }

  private async playSpotify(): Promise<void> {
    try {
      if (this.spStarted && spotify.owner === this) {
        await spotify.player.resume()
        return
      }
      if (spotify.owner && spotify.owner !== this) spotify.owner.spotifyReleased()
      spotify.owner = this
      await spotify.player.activateElement?.()
      await spotify.api('PUT', '/me/player/play?device_id=' + spotify.deviceId, {
        uris: [this.spUri],
        position_ms: Math.round(this.spPos * 1000),
      })
      this.spStarted = true
      this.spPosAt = performance.now()
      this.applyOutput()
    } catch (e) {
      this.set({ error: (e as Error).message, playing: false })
    }
  }

  pause(): void {
    if (this.scratchState) this.scratchEnd() // let go of the record first, then stop it
    const s = this.state
    if (s.kind === 'local') {
      if (!this.src) return
      const pos = this.getPosition()
      this.stopSource()
      this.anchorOffset = pos
      this.set({ playing: false })
    } else if (s.kind === 'youtube') {
      if (this.ytReady) this.yt.pauseVideo()
    } else if (s.kind === 'spotify') {
      if (this.spStarted && spotify.owner === this) spotify.player.pause().catch(() => undefined)
    }
  }

  toggle(): void {
    if (this.state.playing) this.pause()
    else this.play()
  }

  seek(time: number, keepLoop = false): void {
    const s = this.state
    if (s.kind === 'none') return
    const t = s.duration > 0 ? clamp(time, 0, Math.max(0, s.duration - 0.05)) : Math.max(0, time)
    if (s.loop && !keepLoop && (t < s.loop.in || t >= s.loop.out)) this.set({ loop: null })
    if (s.kind === 'local') {
      if (this.src) {
        this.stopSource()
        this.startSource(t)
      } else {
        this.anchorOffset = t
      }
    } else if (s.kind === 'youtube') {
      // Seeking a cued (never started) video would start playback, so defer it.
      if (!this.ytReady || this.ytState === YT_CUED || this.ytState === YT_UNSTARTED) this.ytPending = t
      else this.yt.seekTo(t, true)
    } else {
      this.spPos = t
      this.spPosAt = performance.now()
      if (this.spStarted && spotify.owner === this) spotify.player.seek(Math.round(t * 1000)).catch(() => undefined)
    }
  }

  /** CUE: while playing, jump back to the cue point and stop; while stopped, set the cue point here. */
  cue(): void {
    const s = this.state
    if (s.kind === 'none') return
    if (s.playing) {
      this.pause()
      this.seek(s.cue)
    } else {
      const cue = this.getPosition()
      this.set({ cue })
      // DJs cue on a beat: for a track with no grid yet, that is our best beat reference.
      if (s.anchor === null && s.ref) this.setAnchor(cue)
    }
  }

  private cueHold: { timer: number; previewing: boolean } | null = null

  /**
   * CUE pressed on screen. Playing: back to the cue and stop. Stopped: the cue moves here and, held
   * a moment, the track plays from it until let go (cue preview, as on a CDJ).
   */
  cueDown(): void {
    const s = this.state
    if (s.kind === 'none') return
    if (s.playing) {
      this.cue()
      return
    }
    this.cue()
    const hold = { timer: 0, previewing: false }
    hold.timer = window.setTimeout(() => {
      hold.previewing = true
      this.play()
    }, 180)
    this.cueHold = hold
  }

  /** CUE let go: a preview stops and returns to the cue point. */
  cueUp(): void {
    const hold = this.cueHold
    if (!hold) return
    this.cueHold = null
    window.clearTimeout(hold.timer)
    if (hold.previewing) {
      this.pause()
      this.seek(this.state.cue)
    }
  }

  /** Stopped exactly on the cue point (the CUE button lights). */
  get atCue(): boolean {
    const s = this.state
    return s.kind !== 'none' && !s.playing && Math.abs(this.getPosition() - s.cue) < 0.05
  }

  hotcue(index: number): void {
    const s = this.state
    if (s.kind === 'none') return
    const at = s.hotcues[index]
    if (at === null || at === undefined) {
      const hotcues = s.hotcues.slice()
      hotcues[index] = this.getPosition()
      this.set({ hotcues })
    } else {
      this.seek(at)
    }
  }

  clearHotcue(index: number): void {
    const hotcues = this.state.hotcues.slice()
    hotcues[index] = null
    this.set({ hotcues })
  }

  toggleLoop(beats: number): void {
    const s = this.state
    if (s.kind === 'none') return
    if (s.loop) {
      const same = s.loop.beats === beats
      this.exitLoop()
      if (same) return
    }
    if (!s.bpm) {
      this.set({ error: 'Sem BPM: marca o tempo com TAP' })
      return
    }
    const start = this.getPosition()
    this.setLoop(start, start + (beats * 60) / s.bpm, beats)
  }

  private exitLoop(): void {
    this.reanchor() // position is wrapped while the loop is still set
    for (const n of this.sources) n.loop = false
    this.set({ loop: null, loopIn: null })
  }

  private setLoop(start: number, end: number, beats: number): void {
    if (end > this.state.duration || end - start < 0.02) return
    this.reanchor()
    for (const n of this.sources) {
      n.loopStart = start
      n.loopEnd = end
      n.loop = true
    }
    this.set({ loop: { in: start, out: end, beats }, loopIn: null, error: null })
  }

  /** Manual loop, first press: mark where it begins. */
  loopIn(): void {
    if (this.state.kind === 'none') return
    if (this.state.loop) this.exitLoop()
    this.set({ loopIn: this.getPosition() })
  }

  /** Manual loop, second press: close it here and start looping. Pressed during a loop: leave it. */
  loopOut(): void {
    const s = this.state
    if (s.loop) {
      this.exitLoop()
      return
    }
    if (s.loopIn === null) return
    const out = this.getPosition()
    const beats = s.bpm ? Math.round((((out - s.loopIn) * s.bpm) / 60) * 100) / 100 : 0
    this.setLoop(s.loopIn, out, beats)
  }

  /** Halve or double the running loop, keeping where it begins. */
  loopScale(factor: number): void {
    const loop = this.state.loop
    if (!loop) return
    this.setLoop(loop.in, loop.in + (loop.out - loop.in) * factor, Math.round(loop.beats * factor * 100) / 100)
  }

  // ───────────────────────── reggae moves ─────────────────────────

  /** Dub throw: held, the music is fed into a long echo; let go, the echo rings out on its own. */
  dub(held: boolean): void {
    const s = this.state
    this.set({ dubbing: held && this.canFx })
    this.fxUnit.dub(held && this.canFx, s.bpm ? 60 / (s.bpm * s.rate) : null)
  }

  /** The DUB button itself: works while held, or toggles on each press, as set in dubSettings. */
  dubPress(down: boolean): void {
    if (dubSettings.get().mode === 'latch') {
      if (down) this.dub(!this.state.dubbing)
    } else this.dub(down)
  }

  /**
   * Pull up: the music the crowd just heard runs backwards, faster and faster, and drops out,
   * like a record pulled back by hand. How it sounds and what happens after are set in rewindSettings.
   */
  rewind(): void {
    const s = this.state
    if (s.kind === 'none' || this.rewinding) return
    const cfg = rewindSettings.get()
    this.rewinding = true
    if (s.syncOn) this.syncOff()
    const wasPlaying = s.playing
    const heard = wasPlaying ? this.tape.last(cfg.tape) : Promise.resolve([new Float32Array(0)])
    if (cfg.shout) void sampler.shout(cfg.shout)
    this.pause()
    const stoppedAt = this.getPosition()
    void heard.then(([left, right]) => {
      const ctx = mixer.ctx
      const length = left.length
      const now = ctx.currentTime
      const end = now + cfg.duration
      if (length > ctx.sampleRate * 0.2) {
        const back = ctx.createBuffer(2, length, ctx.sampleRate)
        const l = back.getChannelData(0)
        const r = back.getChannelData(1)
        for (let i = 0; i < length; i++) {
          l[i] = left[length - 1 - i]
          r[i] = (right ?? left)[length - 1 - i]
        }
        const spin = ctx.createBufferSource()
        spin.buffer = back
        spin.playbackRate.setValueAtTime(cfg.startSpeed, now)
        spin.playbackRate.exponentialRampToValueAtTime(cfg.endSpeed, now + cfg.duration * 0.85)
        const tone = ctx.createBiquadFilter()
        tone.type = 'lowpass'
        tone.frequency.setValueAtTime(20000, now)
        tone.frequency.exponentialRampToValueAtTime(20000 * Math.pow(500 / 20000, cfg.muffle), end)
        const fade = ctx.createGain()
        fade.gain.setValueAtTime(1, now)
        fade.gain.setValueAtTime(1, now + cfg.duration * cfg.fadeAt)
        fade.gain.linearRampToValueAtTime(0, end)
        spin.connect(tone)
        tone.connect(fade)
        fade.connect(this.vol) // through the channel fader and crossfader, like the music itself
        spin.start(now)
        spin.stop(end + 0.05)
      }
      if (cfg.after === 'stay') this.seek(stoppedAt, false)
      else this.seek(this.state.cue, false)
      if (cfg.after === 'drop' && wasPlaying) {
        // The track comes back in from the cue the moment the rewind ends.
        window.setTimeout(() => {
          this.rewinding = false
          if (this.state.kind !== 'none' && !this.state.playing) this.play()
        }, cfg.duration * 1000)
      } else this.rewinding = false
    })
  }

  // ───────────────────────── tempo ─────────────────────────

  get canPitch(): boolean {
    return this.state.kind === 'local' || this.state.kind === 'youtube'
  }

  private pushRate(): void {
    const rate = this.state.rate * this.bend
    for (const n of this.sources) n.playbackRate.value = rate
    // Key lock: the file plays faster/slower, the shifter brings the pitch back.
    if (this.pitchNode) setPitch(this.pitchNode, this.state.keyLock ? 1 / rate : 1)
    // While sync is on, syncStep() drives the YouTube rate itself (it alternates between 5% steps).
    if (this.state.kind === 'youtube' && this.ytReady && !this.state.syncOn) this.yt.setPlaybackRate(rate)
  }

  /** Manual tempo change (pitch fader, MIDI): takes the deck out of sync. */
  setRate(rate: number): void {
    if (!this.canPitch) return
    if (this.state.syncOn) this.syncOff()
    this.reanchor()
    this.set({ rate: clamp(rate, 0.5, 2) })
    this.pushRate()
  }

  /** Pitch +/− buttons: one step up or down (0.5%; YouTube only accepts 5% steps). */
  stepRate(direction: 1 | -1): void {
    const step = this.state.kind === 'youtube' ? 0.05 : 0.005
    this.setRate(Math.round((this.state.rate + direction * step) / step) * step)
  }

  /** Temporary speed offset (jog wheel / nudge buttons) on top of the pitch fader. */
  setBend(bend: number): void {
    if (!this.canPitch || bend === this.bend) return
    this.reanchor()
    this.bend = bend
    this.pushRate()
  }

  // ───────────────────────── jog ─────────────────────────
  //
  // The platter is read as a hand speed, smoothed and updated every frame, not as one jump per message:
  //  · playing: nudge — the tempo leans with the hand's speed and settles back to normal when it lets go;
  //  · stopped: the track glides under the hand;
  //  · vinyl (top of the platter, files): scratch — the music runs at the hand's speed, backwards too,
  //    and a hand resting on the platter holds the record still.

  /** One tick = 30 ms of music (a full turn of the on-screen platter = 1.8 s). */
  private static readonly TICK = 0.03
  private jogTicks = 0
  private jogVel = 0 // smoothed hand speed, seconds of music per second
  private jogLastInput = 0
  private jogRaf = 0
  private jogLastFrame = 0
  private jogKind: 'nudge' | 'seek' | 'scratch' = 'nudge'
  private scratchState: {
    pos: number
    dir: 1 | -1
    node: AudioBufferSourceNode | null
    wasPlaying: boolean
    touch: boolean // held by a touch sensor (ends on release), else ends when the hand stops moving
  } | null = null
  private reversed: AudioBuffer | null = null

  /** Relative jog movement: nudges the tempo while playing, glides through the track while stopped. */
  jog(ticks: number): void {
    if (this.state.kind === 'none') return
    if (this.scratchState) return this.scratch(ticks)
    this.jogKind = this.state.playing ? 'nudge' : 'seek'
    this.jogInput(ticks)
  }

  /** Vinyl mode, top of the platter: scratch while playing (files); otherwise the same as jog(). */
  scratch(ticks: number): void {
    const s = this.state
    if (s.kind !== 'local' || !this.buffer || (!s.playing && !this.scratchState)) return this.jog(ticks)
    if (!this.scratchState) this.scratchBegin(false)
    this.jogKind = 'scratch'
    this.jogInput(ticks)
  }

  /** Touch sensor on the platter (vinyl mode): a hand on a playing record holds it; lifting it lets it go. */
  jogTouch(down: boolean): void {
    if (down) {
      if (this.state.kind === 'local' && this.state.playing && !this.scratchState) {
        this.scratchBegin(true)
        this.jogKind = 'scratch'
        this.jogInput(0)
      }
    } else if (this.scratchState) this.scratchEnd()
  }

  private jogInput(ticks: number): void {
    this.jogTicks += ticks
    this.jogLastInput = performance.now()
    if (!this.jogRaf) {
      this.jogLastFrame = performance.now()
      this.jogRaf = requestAnimationFrame(this.jogFrame)
    }
  }

  private jogFrame = (): void => {
    const now = performance.now()
    const dt = Math.max(0.001, (now - this.jogLastFrame) / 1000)
    this.jogLastFrame = now
    const moved = this.jogTicks * Deck.TICK // seconds of music the hand moved this frame
    this.jogTicks = 0
    const idle = now - this.jogLastInput
    // Hand speed: follows new movement within ~50 ms (whatever the frame rate) and fades out once the hand stops.
    if (moved) this.jogVel += (moved / dt - this.jogVel) * (1 - Math.exp(-dt / 0.05))
    else this.jogVel *= Math.exp(-dt / 0.07)

    let done = false
    if (this.jogKind === 'nudge') {
      if (!this.state.playing) done = true
      else {
        // The tempo leans towards the hand's speed like a heavy platter: never more than ~1.5% per frame.
        const target = 1 + clamp(this.jogVel * 0.12, -0.3, 0.3)
        const lean = this.bend + clamp(target - this.bend, -0.9 * dt, 0.9 * dt)
        this.setBend(lean)
        done = idle > 250 && Math.abs(this.jogVel) < 0.01 && Math.abs(this.bend - 1) < 0.002
        if (done) this.setBend(1)
      }
    } else if (this.jogKind === 'seek') {
      if (moved) this.seek(this.getPosition() + moved, true)
      done = idle > 120
    } else {
      done = this.scratchFrame(dt, idle)
    }
    if (done) {
      this.jogRaf = 0
      this.jogVel = 0
      return
    }
    this.jogRaf = requestAnimationFrame(this.jogFrame)
  }

  /** A reversed copy of the track, so scratching backwards plays the sound backwards. */
  private reverseBuffer(): AudioBuffer {
    if (this.reversed && this.reversed.length === this.buffer!.length) return this.reversed
    const b = this.buffer!
    const r = new AudioBuffer({ length: b.length, numberOfChannels: b.numberOfChannels, sampleRate: b.sampleRate })
    for (let c = 0; c < b.numberOfChannels; c++) r.copyToChannel(b.getChannelData(c).slice().reverse(), c)
    this.reversed = r
    return r
  }

  private scratchBegin(touch: boolean): void {
    const pos = this.getPosition()
    const wasPlaying = this.state.playing
    this.stopSource()
    this.scratchState = { pos, dir: 1, node: null, wasPlaying, touch }
    this.scratchNode(1, 0)
  }

  /** (Re)starts the scratch voice in a direction, at the current hand position, at a given speed. */
  private scratchNode(dir: 1 | -1, speed: number): void {
    const st = this.scratchState!
    st.node?.stop()
    st.node?.disconnect()
    const ctx = mixer.ctx
    const n = ctx.createBufferSource()
    n.buffer = dir === 1 ? this.buffer! : this.reverseBuffer()
    n.playbackRate.value = speed
    n.connect(this.srcBus)
    const offset = dir === 1 ? st.pos : this.buffer!.duration - st.pos
    n.start(ctx.currentTime, clamp(offset, 0, this.buffer!.duration - 0.01))
    st.node = n
    st.dir = dir
  }

  /** One frame of scratching; returns true when the scratch is over. */
  private scratchFrame(dt: number, idle: number): boolean {
    const st = this.scratchState
    if (!st) return true
    const v = this.jogVel
    st.pos = clamp(st.pos + v * dt, 0, this.state.duration - 0.01)
    const dir: 1 | -1 = v > 0.02 ? 1 : v < -0.02 ? -1 : st.dir
    if (dir !== st.dir) this.scratchNode(dir, Math.abs(v))
    else st.node?.playbackRate.setTargetAtTime(Math.abs(v) < 0.02 ? 0 : Math.abs(v), mixer.ctx.currentTime, 0.008)
    // Without a touch sensor the scratch ends when the hand has stopped for a moment.
    if (!st.touch && idle > 180 && Math.abs(v) < 0.02) {
      this.scratchEnd()
      return true
    }
    return false
  }

  /** The record is let go: it plays on from where the hand left it. */
  private scratchEnd(): void {
    const st = this.scratchState
    if (!st) return
    this.scratchState = null
    st.node?.stop()
    st.node?.disconnect()
    this.anchorOffset = st.pos
    if (st.wasPlaying && this.state.playing) this.startSource(st.pos)
  }

  // ───────────────────────── sync ─────────────────────────

  /** SYNC toggle: follow the other deck's tempo and, when both have a beat grid, its beat phase. */
  sync(other: Deck): void {
    if (this.state.syncOn) {
      this.syncOff()
      return
    }
    if (!this.state.bpm || !other.get().bpm) {
      this.set({ error: 'SYNC precisa de BPM nos dois decks (usa TAP)' })
      return
    }
    if (!this.canPitch) {
      this.set({ error: 'Spotify não permite alterar o tempo' })
      return
    }
    if (other.get().syncOn) other.syncOff() // two decks cannot follow each other
    this.syncMaster = other
    this.set({ syncOn: true, error: null })
    this.syncStep()
    this.syncJump()
  }

  private syncOff(): void {
    this.syncMaster = null
    this.set({ syncOn: false })
    this.setBend(1)
    this.pushRate()
  }

  /** Rate that makes this deck's tempo equal the master's (allowing half/double time). */
  private syncTargetRate(master: Deck): number | null {
    const mine = this.state.bpm
    const m = master.get()
    if (!mine || !m.bpm) return null
    let rate = (m.bpm * m.rate) / mine
    while (rate > 1.42) rate /= 2
    while (rate < 0.71) rate *= 2
    return rate
  }

  /**
   * How far (seconds of real time) this deck's beats are behind the master's; negative = ahead.
   * null when either grid is unknown or a deck is stopped.
   */
  private phaseError(master: Deck, targetRate: number): number | null {
    const s = this.state
    const m = master.get()
    if (!s.playing || !m.playing || !s.bpm || !m.bpm || s.anchor === null || m.anchor === null) return null
    const frac = (x: number) => x - Math.floor(x)
    let mine = frac((this.heardPosition() - s.anchor) / (60 / s.bpm))
    let theirs = frac((master.heardPosition() - m.anchor) / (60 / m.bpm))
    const myPeriod = 60 / s.bpm / targetRate
    const theirPeriod = 60 / m.bpm / m.rate
    // Half/double time: compare on the faster deck's beat.
    let period = theirPeriod
    if (myPeriod > theirPeriod * 1.5) mine = frac(mine * 2)
    else if (theirPeriod > myPeriod * 1.5) {
      theirs = frac(theirs * 2)
      period = myPeriod
    }
    let d = theirs - mine
    d -= Math.round(d)
    return d * period
  }

  /** Files can seek sample-accurately: jump straight onto the master's beat. */
  private syncJump(): void {
    const master = this.syncMaster
    if (!master || !this.state.syncOn || this.state.kind !== 'local') return
    const target = this.syncTargetRate(master)
    const err = target && this.phaseError(master, target)
    if (err) this.seek(this.getPosition() + err * target, true)
  }

  /** Runs every tick while sync is on: hold the master's tempo and pull the beats together. */
  private syncStep(): void {
    const master = this.syncMaster
    if (!master) return
    const target = this.syncTargetRate(master)
    if (target === null) return
    if (Math.abs(target - this.state.rate) > 0.0005) {
      this.reanchor()
      this.set({ rate: target })
      this.pushRate()
    }
    const err = this.phaseError(master, target)
    if (this.state.kind === 'local') {
      // Proportional correction: a 20 ms gap closes in well under a second, inaudibly.
      this.setBend(err === null || Math.abs(err) < 0.003 ? 1 : 1 + clamp(err * 1.5, -0.08, 0.08))
    } else if (this.state.kind === 'youtube' && this.ytReady) {
      // YouTube only accepts 5% speed steps (pitch is preserved), so the exact tempo is reached
      // on average by hopping between the step above and the step below, steered by the beat gap.
      const desired = target * (1 + (err === null ? 0 : clamp(err * 1.2, -0.15, 0.15)))
      const lo = Math.floor(desired / 0.05 + 1e-6) * 0.05
      let step: number
      if (err === null || Math.abs(err) < 0.008) step = Math.round(target / 0.05) * 0.05
      else step = err > 0 ? lo + 0.05 : lo
      step = Math.round(clamp(step, 0.5, 2) * 100) / 100
      const now = performance.now()
      if (step !== this.ytApplied && now - this.ytSwitchedAt > 150) {
        this.yt.setPlaybackRate(step)
        this.ytApplied = step
        this.ytSwitchedAt = now
      }
    }
  }

  // ───────────────────────── beat grid ─────────────────────────

  private setAnchor(anchor: number | null): void {
    this.set({ anchor })
    if (this.state.ref) bpmStore.rememberAnchor(this.state.ref, anchor)
  }

  /**
   * TAP on the beat while the track plays. Sets the beat grid (where the beats fall), and also
   * the BPM when none is known or the taps clearly disagree with it.
   */
  tap(): void {
    const now = performance.now()
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) {
      this.taps = []
      this.tapPositions = []
    }
    this.taps.push(now)
    this.tapPositions.push(this.getPosition())
    if (this.taps.length > 8) {
      this.taps.shift()
      this.tapPositions.shift()
    }
    if (this.taps.length < 3) return
    const interval = (now - this.taps[0]) / (this.taps.length - 1)
    const tapped = 60000 / interval / this.state.rate
    const known = this.state.bpm
    const agrees = known !== null && [1, 2, 0.5].some((f) => Math.abs(tapped * f - known) / known < 0.06)
    const bpm = agrees ? known : Math.round(tapped * 10) / 10
    if (!agrees) this.commitBpm(bpm)
    if (!this.state.playing) return
    // Circular mean of the tapped positions within one beat = where the beat sits.
    const beat = 60 / bpm
    let x = 0
    let y = 0
    for (const p of this.tapPositions) {
      const angle = (2 * Math.PI * p) / beat
      x += Math.cos(angle)
      y += Math.sin(angle)
    }
    const phase = Math.atan2(y, x) / (2 * Math.PI)
    this.setAnchor((phase < 0 ? phase + 1 : phase) * beat)
  }

  /** A BPM the user vouches for (tap, ½, ×2): keep it and remember it for this track. */
  private commitBpm(bpm: number): void {
    this.bpmTrusted = true
    if (this.state.ref) bpmStore.remember(this.state.ref, bpm)
    this.set({ bpm, error: null })
  }

  /** Desktop app: a slice of the YouTube sound just heard. Feeds the automatic BPM / beat grid. */
  private onLiveChunk(chunk: Float32Array): void {
    const live = this.live
    const s = this.state
    if (!live) return
    if (s.kind === 'youtube' && s.playing) {
      this.wave.add(chunk, this.liveRate, this.getPosition(), s.rate)
      if (!this.keyKnown) this.liveKey?.sample()
    }
    // Only steady playback is analysed (while SYNC is on the speed hops between steps).
    if (s.kind !== 'youtube' || !s.playing || s.syncOn || this.bend !== 1) {
      live.reset()
      return
    }
    const result = live.feed(chunk, this.getPosition(), s.rate, s.bpm)
    if (!result) return
    if (result.bpm !== undefined) this.commitBpm(result.bpm)
    if (result.anchor !== undefined) {
      this.set({ anchor: result.anchor })
      if (s.ref) bpmStore.rememberAnchor(s.ref, result.anchor)
    }
  }

  /**
   * Desktop app: sound from the silent look-ahead scan of the clip (played at double speed).
   * Gives the clip a BPM and beat grid before it is played; once the deck plays, its own sound
   * (onLiveChunk) takes over, because that grid is measured right where the playhead is.
   */
  private onScanChunk(chunk: Float32Array, envRate: number, position: number, rate: number): void {
    const s = this.state
    if (s.kind !== 'youtube') return
    // Analysed in clip time: at double speed each second of clip arrives as half the samples.
    this.scanGrid ??= new LiveGrid(envRate / SCAN_SPEED, 3)
    const result = this.scanGrid.feed(chunk, position - CAPTURE_LATENCY * rate, rate / SCAN_SPEED, s.bpm)
    if (!result) return
    if (result.bpm !== undefined && (!s.playing || s.bpm === null)) {
      this.scanAnchors = [] // measured with another tempo
      this.commitBpm(result.bpm)
    }
    if (result.anchor !== undefined) {
      this.scanAnchors.push(result.anchor)
      if (!s.playing || s.anchor === null) this.useScanAnchor()
    }
  }

  /** While the clip is not playing, its grid is the scanned beat nearest to the playhead. */
  private useScanAnchor(): void {
    if (!this.scanAnchors.length) return
    const position = this.getPosition()
    let best = this.scanAnchors[0]
    for (const a of this.scanAnchors) if (Math.abs(a - position) < Math.abs(best - position)) best = a
    if (best === this.state.anchor) return
    this.set({ anchor: best })
    if (this.state.ref) bpmStore.rememberAnchor(this.state.ref, best)
  }

  /** Streaming track loaded: use the remembered BPM if there is one. */
  private recall(ref: string): void {
    const bpm = bpmStore.bpm(ref)
    this.bpmTrusted = bpm !== null
    this.live?.clear()
    this.scanGrid?.clear()
    this.scanAnchors = []
    this.liveKey?.chroma.clear()
    const key = keyStore.get(ref)
    this.keyKnown = key !== null
    this.set({ ref, bpm, anchor: bpmStore.anchor(ref), key })
  }

  /** Title known: look the song's BPM up online (no-op when already known). */
  private lookupBpm(force = false): void {
    const { ref, title, artist, bpm } = this.state
    if (ref && !bpm && title) bpmStore.lookup(ref, title, artist, force)
  }

  /** BPM found for a track (online lookup or analyzer window); arrives whatever this deck is doing. */
  private onAnalysed(ref: string, bpm: number): void {
    if (ref !== this.state.ref || this.bpmTrusted) return
    this.set({ bpm, error: null })
  }

  /** Forget the BPM and analyse again (file: re-scan; streaming: new online lookup). */
  resetBpm(): void {
    this.bpmTrusted = false
    this.taps = []
    const ref = this.state.ref
    if (ref) bpmStore.remember(ref, null)
    const bpm = this.buffer ? detectBpm(this.buffer) : null
    this.set({ bpm, anchor: this.buffer && bpm ? detectBeatAnchor(this.buffer, bpm) : null, error: null })
    if (ref) bpmStore.rememberAnchor(ref, null)
    this.live?.clear()
    this.scanGrid?.clear()
    this.scanAnchors = []
    this.lookupBpm(true)
  }

  scaleBpm(factor: number): void {
    if (this.state.bpm) this.commitBpm(Math.round(this.state.bpm * factor * 10) / 10)
  }

  // ───────────────────────── mixer channel ─────────────────────────

  setVolume(v: number): void {
    this.set({ volume: clamp(v, 0, 1) })
    this.vol.gain.setTargetAtTime(this.state.volume, mixer.ctx.currentTime, 0.01)
    this.applyOutput()
  }

  setEq(band: EqBand, v: number): void {
    const value = clamp(v, -1, 1)
    this.set({ [band]: value } as Partial<DeckState>)
    // Cut down to -30 dB (near kill), boost up to +8 dB.
    this.eq[band].gain.setTargetAtTime(value < 0 ? value * 30 : value * 8, mixer.ctx.currentTime, 0.01)
  }

  /** Headphone button: hear this deck in the headphones before (or without) bringing it into the mix. */
  togglePfl(): void {
    const pfl = !this.state.pfl
    this.set({ pfl })
    this.pflSend.gain.setTargetAtTime(pfl ? 1 : 0, mixer.ctx.currentTime, 0.01)
  }

  /** Fine waveform for the scrolling view: `rate` peaks per second; `top` is the level drawn at full height. */
  detail(): { data: Float32Array; rate: number; top: number } | null {
    if (this.state.kind === 'local') return this.localDetail && { data: this.localDetail, rate: 100, top: 1 }
    if (this.state.kind === 'youtube') return this.wave.detail()
    return null
  }

  /** The deck's sound after EQ and effects, before its fader: what a level meter should read. */
  get meterTap(): AudioNode {
    return this.fxUnit.output
  }

  // ───────────────────────── key ─────────────────────────

  get canKeyLock(): boolean {
    return this.state.kind === 'local'
  }

  /** How far the pitch fader moves the key, in whole semitones (0 while key lock holds it, or on streams). */
  get keyShift(): number {
    const s = this.state
    if (s.kind !== 'local' || s.keyLock) return 0
    return Math.round(12 * Math.log2(s.rate))
  }

  /** The key the crowd hears right now. */
  get heardKey(): string | null {
    return transpose(this.state.key, this.keyShift)
  }

  /** Key lock on a file: changing the tempo no longer changes the pitch. */
  toggleKeyLock(): void {
    this.set({ keyLock: !this.state.keyLock })
    this.routeSource()
    this.pushRate()
  }

  private routeSource(): void {
    this.srcBus.disconnect()
    this.srcBus.connect(this.state.keyLock && this.pitchNode ? this.pitchNode : this.input)
  }

  /** Position of what is being heard right now (the key lock delays the sound slightly). */
  heardPosition(): number {
    const s = this.state
    const late = s.kind === 'local' && s.keyLock && s.playing && this.pitchNode ? KEYLOCK_LATENCY * s.rate : 0
    return this.getPosition() - late
  }

  /** YouTube clips: take the key from the look-ahead scan or from the clip's own playback, whichever heard more. */
  private updateClipKey(): void {
    const s = this.state
    if (s.kind !== 'youtube' || !s.ref || this.keyKnown) return
    const scan = this.wave.scanKey()
    const live = { key: this.liveKey?.chroma.key() ?? null, frames: this.liveKey?.chroma.frames ?? 0 }
    const best = scan.frames >= live.frames ? scan : live
    if (best.frames < 100 || !best.key || best.key === s.key) return
    this.set({ key: best.key })
    keyStore.set(s.ref, best.key)
  }

  /** Channel gain (trim): evens out quiet and loud tracks before the EQ. -1..1 = -12..+12 dB. */
  setGain(v: number): void {
    const gain = clamp(v, -1, 1)
    this.set({ gain })
    this.input.gain.setTargetAtTime(Math.pow(10, (gain * 12) / 20), mixer.ctx.currentTime, 0.01)
  }

  // ───────────────────────── effects ─────────────────────────

  /** Effects need the sound inside the app: files, and YouTube clips in the desktop app. */
  get canFx(): boolean {
    return this.canStems
  }

  setFx(fx: FxType): void {
    this.set({ fx })
    this.pushFx()
  }

  toggleFx(): void {
    if (!this.canFx) return
    this.set({ fxOn: !this.state.fxOn })
    this.pushFx()
  }

  setFxAmount(v: number): void {
    this.set({ fxAmount: clamp(v, 0, 1) })
    this.pushFx()
  }

  private pushFx(): void {
    const s = this.state
    const beat = s.bpm ? 60 / (s.bpm * s.rate) : null
    this.fxUnit.apply(s.fx, s.fxOn && this.canFx, s.fxAmount, beat)
  }

  get canStems(): boolean {
    return this.state.kind === 'local' || (this.state.kind === 'youtube' && this.state.processed)
  }

  /** Mute / unmute one part of the music (vocal, instruments, bass, kick, hi-hat). */
  toggleStem(stem: Stem): void {
    if (!this.canStems) return
    this.set({ stems: { ...this.state.stems, [stem]: !this.state.stems[stem] } })
    this.pushStems()
  }

  /** Solo: only this stem plays; calling it again on the soloed stem brings everything back. */
  /** Sets every part at once (the automatic dub changes several on the same beat). */
  setStems(stems: Partial<StemState>): void {
    if (!this.canStems) return
    this.set({ stems: { ...this.state.stems, ...stems } })
    this.pushStems()
  }

  soloStem(stem: Stem): void {
    if (!this.canStems) return
    const st = this.state.stems
    const alreadySolo = st[stem] && Object.values(st).filter(Boolean).length === 1
    const stems = { ...ALL_STEMS }
    if (!alreadySolo) for (const k of Object.keys(stems) as Stem[]) stems[k] = k === stem
    this.set({ stems })
    this.pushStems()
  }

  private pushStems(): void {
    const ai = this.stemBuffers !== null
    // With AI stems the pads drive their own levels and the filter-based splitter passes everything.
    if (this.stemsNode) setStems(this.stemsNode, ai ? ALL_STEMS : this.state.stems)
    const now = mixer.ctx.currentTime
    for (const stem of STEMS) this.aiOut[stem].gain.setTargetAtTime(!ai || this.state.stems[stem] ? 1 : 0, now, 0.008)
  }

  // ───────────────────────── AI stems (desktop app, files) ─────────────────────────

  /**
   * Pads for AI stems: vocals, other (INS) and bass go straight to their pad; the drum stem is split
   * at 150 Hz into KICK (below) and HAT (the rest of the kit) with a Linkwitz-Riley crossover,
   * so with both on the drums are whole again.
   */
  private buildAiStems(ctx: AudioContext): void {
    const gain = (): GainNode => ctx.createGain()
    const filter = (type: BiquadFilterType): BiquadFilterNode => {
      const f = ctx.createBiquadFilter()
      f.type = type
      f.frequency.value = 150
      f.Q.value = Math.SQRT1_2
      return f
    }
    this.aiIn = { vocals: gain(), drums: gain(), bass: gain(), other: gain() }
    this.aiOut = { vocal: gain(), instr: gain(), bass: gain(), kick: gain(), hat: gain() }
    this.aiIn.vocals.connect(this.aiOut.vocal)
    this.aiIn.other.connect(this.aiOut.instr)
    this.aiIn.bass.connect(this.aiOut.bass)
    const [lo1, lo2, hi1, hi2] = [filter('lowpass'), filter('lowpass'), filter('highpass'), filter('highpass')]
    this.aiIn.drums.connect(lo1).connect(lo2).connect(this.aiOut.kick)
    this.aiIn.drums.connect(hi1).connect(hi2).connect(this.aiOut.hat)
    for (const out of Object.values(this.aiOut)) out.connect(this.srcBus)
  }

  /**
   * Lyrics for a file the online catalogue does not know: transcribed on this Mac, from the vocal stem
   * when there is one (much clearer than the whole mix).
   */
  private async autoLyrics(token: number, fingerprint: Promise<ArrayBuffer>): Promise<void> {
    if (token !== this.token || !this.buffer) return
    const id = [...new Uint8Array(await fingerprint)].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (token !== this.token) return
    const s = this.state
    void lyrics.fromAudio('file:' + s.title, s.title, s.artist, s.duration, id, this.stemBuffers?.vocals ?? this.buffer, this.name)
  }

  /** Loads the AI stems of this file: from the cache at once, or separated now (about half a minute). */
  private async loadAiStems(token: number, fingerprint: Promise<ArrayBuffer>): Promise<void> {
    if (!desktop?.stemsSave || !this.buffer) return
    const digest = await fingerprint
    const id = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (token !== this.token) return
    this.fileId = id
    let files = await desktop.stemsCached(id)
    if (token !== this.token) return
    if (!files) {
      this.set({ aiStems: 'working', aiProgress: 0 })
      try {
        // Separated inside the app (built-in model), then stored per track by the desktop shell.
        const stems = await separateStems(this.buffer, (p) => token === this.token && this.set({ aiProgress: p * 0.97 }))
        files = await desktop.stemsSave(id, stems, SAMPLE_RATE)
      } catch (e) {
        console.warn('AI stems failed', e)
        if (token === this.token) this.set({ aiStems: 'error' })
        return
      }
    }
    if (!files || token !== this.token) return
    const parts = await Promise.all(AI_PARTS.map((part) => mixer.ctx.decodeAudioData(files[part].slice().buffer)))
    if (token !== this.token) return
    this.stemBuffers = Object.fromEntries(AI_PARTS.map((part, i) => [part, parts[i]])) as Record<AiPart, AudioBuffer>
    // Swap the running sound over to the stems without moving the playhead.
    if (this.src) {
      const pos = this.getPosition()
      this.stopSource()
      this.startSource(pos)
    }
    this.set({ aiStems: 'ready', aiProgress: 1 })
    this.pushStems()
  }

  setFilter(v: number): void {
    const value = clamp(v, -1, 1)
    this.set({ filter: value })
    const node = this.filterNode
    const now = mixer.ctx.currentTime
    if (Math.abs(value) < 0.04) {
      node.type = 'allpass'
    } else if (value < 0) {
      node.type = 'lowpass'
      node.frequency.setTargetAtTime(20000 * Math.pow(120 / 20000, -value), now, 0.01)
    } else {
      node.type = 'highpass'
      node.frequency.setTargetAtTime(20 * Math.pow(6000 / 20, value), now, 0.01)
    }
  }

  /** Push channel fader × crossfader (× master for external players) to whatever is producing sound. */
  applyOutput(): void {
    const side = mixer.sideGain(this.side)
    this.xfade.gain.setTargetAtTime(side, mixer.ctx.currentTime, 0.01)
    const external = this.state.volume * side * mixer.get().master
    if (this.state.kind === 'youtube' && this.ytReady) {
      // Processed YouTube audio is mixed by the deck's own gains (and the master bus), like a file.
      this.yt.setVolume(this.state.processed ? 100 : Math.round(external * 100))
    }
    if (this.state.kind === 'spotify' && spotify.owner === this) {
      spotify.player?.setVolume(external).catch(() => undefined)
    }
  }

  private tick(): void {
    const s = this.state
    if (s.kind === 'youtube' && this.ytReady && !s.duration) this.ytMeta()
    if (s.syncOn) this.syncStep()
    if (this.ticks % 40 === 20) this.updateClipKey()
    if (this.ticks % 10 === 9 && s.fxOn) this.pushFx() // keeps the echo on the beat when the tempo moves
    // Clip waveform grows while it is scanned / played: redraw twice a second.
    if (++this.ticks % 10 === 0 && s.kind === 'youtube' && this.wave.dirty) {
      this.wave.dirty = false
      this.set({ peaks: this.wave.peaks() })
    }
    // External players cannot loop natively: emulate by seeking back.
    if (s.loop && s.playing && s.kind !== 'local' && this.getPosition() >= s.loop.out) this.seek(s.loop.in, true)
  }
}

export const deckA = new Deck(0, 'A')
export const deckB = new Deck(1, 'B')
export const decks = [deckA, deckB] as const
