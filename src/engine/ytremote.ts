/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Desktop app only. A YouTube player living in its own muted <webview> (public/ytdeck.html),
 * exposed with the same methods the deck uses on a normal YT.Player, plus the page's audio as a
 * MediaStream so the deck can run it through EQ, filter and stems.
 */

type StemPart = 'vocals' | 'drums' | 'bass' | 'other'
export type StemFiles = Record<StemPart, Uint8Array>

/** The desktop app's updater (electron/updater.cjs). */
export interface UpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error' | 'dev'
  current: string // this app's version
  version?: string // the new one
  notes?: string
  url?: string
  progress?: number
  error?: string
  checkedAt?: number
}

/** The phone controller's server (electron/remote.cjs). */
export interface RemoteInfo {
  on: boolean
  port: number
  clients: number
  urls: string[] // one per address of this Mac on the network (Wi-Fi first)
  error?: string
}

interface DesktopBridge {
  capture(webContentsId: number): Promise<boolean>
  pathOf(file: File): string | null
  readAudio(filePath: string): Promise<Uint8Array | null>
  stemsAvailable(): Promise<boolean>
  stemsHas?(id: string): Promise<string | null> // the model that made the stored stems
  setZoom?(factor: number): Promise<void> // size of the whole interface
  updateState?(): Promise<UpdateState | null>
  updateCheck?(): Promise<void>
  updateInstall?(): Promise<void>
  onUpdate?(callback: (state: UpdateState) => void): () => void
  remoteStart?(): Promise<RemoteInfo>
  remoteStop?(): Promise<RemoteInfo>
  remoteInfo?(): Promise<RemoteInfo>
  remoteRenew?(): Promise<RemoteInfo>
  remoteState?(text: string): void
  remoteReply?(client: number, text: string): void
  onRemote?(callback: (msg: Record<string, unknown>, client: number) => void): () => void
  onRemoteClients?(callback: (n: number) => void): () => void
  onZoomKey?(callback: (step: number) => void): () => void // ⌘+ (1) / ⌘− (−1) / ⌘0 (0)
  stemsCached(id: string): Promise<StemFiles | null>
  stemsSave(id: string, stems: Record<StemPart, Float32Array>, rate: number): Promise<StemFiles | null>
  onStemsProgress(callback: (id: string, progress: number) => void): () => void
  lyricsAvailable?(): Promise<boolean>
  micAccess?(): Promise<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>
  micSettings?(): Promise<void>
  lyricsModel?(): Promise<{ bin: boolean; ready: boolean; sizeMb: number }>
  lyricsInstall?(): Promise<boolean>
  onLyricsInstallProgress?(callback: (progress: number) => void): () => void
  lyricsCached?(id: string, lang: string): Promise<{ time: number; text: string }[] | null>
  transcribe?(id: string, pcm: Float32Array, lang: string): Promise<{ time: number; text: string }[] | null>
  onLyricsProgress?(callback: (id: string, progress: number) => void): () => void
  voices?(): Promise<{ name: string; lang: string }[]>
  speak?(text: string, voice: string, rate: number): Promise<Uint8Array | null>
}
export const desktop: DesktopBridge | undefined = (window as any).vxDesktop

/** How much later the captured sound arrives compared with the player's reported position (measured). */
export const CAPTURE_LATENCY = 0.036

const wall = (): number => performance.timeOrigin + performance.now()
const AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false }

let queue: Promise<unknown> = Promise.resolve()

/** Audio of one deck page. Captures run one at a time: the shell pairs each request with one page. */
function capture(webContentsId: number): Promise<MediaStream> {
  const run = (): Promise<MediaStream> =>
    new Promise((resolve, reject) => {
      const w = window as any
      const timer = window.setTimeout(() => reject(new Error('capture timeout')), 8000)
      w.__vxGrab = () => {
        delete w.__vxGrab
        navigator.mediaDevices
          .getDisplayMedia({ video: true, audio: AUDIO })
          .then((stream) => {
            stream.getVideoTracks().forEach((t) => t.stop())
            if (!stream.getAudioTracks().length) throw new Error('no audio track')
            resolve(stream)
          })
          .catch(reject)
          .finally(() => window.clearTimeout(timer))
      }
      desktop!.capture(webContentsId).then((ok) => {
        if (!ok) reject(new Error('capture refused'))
      }, reject)
    })
  const result = queue.then(run, run)
  queue = result.catch(() => undefined)
  return result
}

export interface RemoteEvents {
  onReady(): void
  onStateChange(e: { data: number }): void
  onError(e: { data: number }): void
  onPlaybackRateChange(e: { data: number }): void
}

export class RemotePlayer {
  private channel: BroadcastChannel
  private last = { state: -1, time: 0, at: 0, rate: 1, duration: 0, videoId: '', title: '', author: '' }
  private ready = false
  private ignoreBefore = 0 // reports older than this predate our last seek

  constructor(
    host: HTMLElement,
    deck: string,
    private events: RemoteEvents,
    onStream: (stream: MediaStream) => void,
  ) {
    this.channel = new BroadcastChannel('vx-yt-' + deck)
    this.channel.onmessage = (e) => this.onMessage(e.data)
    const view = document.createElement('webview') as any
    view.setAttribute('src', '/ytdeck.html?deck=' + deck)
    view.style.cssText = 'width:100%;height:100%;display:flex'
    view.addEventListener(
      'dom-ready',
      () => {
        view.setAudioMuted(true)
        capture(view.getWebContentsId()).then(onStream, (err) => console.warn('YouTube audio capture failed', err))
        this.send({ cmd: 'hello' })
      },
      { once: true },
    )
    host.appendChild(view)
  }

  private send(message: Record<string, unknown>): void {
    this.channel.postMessage(message)
  }

  private onMessage(m: any): void {
    if (!m || m.cmd) return
    if (m.type === 'error') {
      this.events.onError({ data: m.code })
      return
    }
    if (m.at < this.ignoreBefore) return
    const previous = this.last
    this.last = m
    if (!this.ready) {
      this.ready = true
      this.events.onReady()
    }
    if (m.state !== previous.state) this.events.onStateChange({ data: m.state })
    if (m.rate !== previous.rate) this.events.onPlaybackRateChange({ data: m.rate })
  }

  getCurrentTime(): number {
    const l = this.last
    return l.state === 1 ? l.time + ((wall() - l.at) / 1000) * l.rate : l.time
  }
  getPlayerState(): number {
    return this.last.state
  }
  getPlaybackRate(): number {
    return this.last.rate
  }
  getDuration(): number {
    return this.last.duration
  }
  getVideoData(): { video_id: string; title: string; author: string } {
    return { video_id: this.last.videoId, title: this.last.title, author: this.last.author }
  }
  cueVideoById(id: string): void {
    // Forget the old clip's state: a stopped clip already reads "cued", and the new clip's "cued" must
    // still count as a change, or the deck waits for it forever (stuck loading, PLAY never starts).
    this.ignoreBefore = wall() + 15
    this.last = { ...this.last, state: -1, time: 0, at: wall(), duration: 0, videoId: '', title: '', author: '' }
    this.send({ cmd: 'cue', id })
  }
  stopVideo(): void {
    this.send({ cmd: 'stop' })
  }
  playVideo(): void {
    this.send({ cmd: 'play' })
  }
  pauseVideo(): void {
    this.send({ cmd: 'pause' })
  }
  seekTo(t: number): void {
    this.ignoreBefore = wall() + 15
    this.last = { ...this.last, time: t, at: wall() }
    this.send({ cmd: 'seek', t })
  }
  setPlaybackRate(r: number): void {
    this.send({ cmd: 'rate', r })
  }
  /** The page always plays at full volume; the deck's own gain does the mixing. */
  setVolume(): void {}
}
