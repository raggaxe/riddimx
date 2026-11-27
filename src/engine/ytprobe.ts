/* eslint-disable @typescript-eslint/no-explicit-any */
import { loadYT } from './youtube'
import { desktop } from './ytremote'

/**
 * Finds out whether a YouTube video plays here before it gets near the library: some owners only
 * allow their videos on youtube.com (error 101 / 150), which oEmbed does not always tell. A hidden,
 * muted player of the same kind the decks use (its own page in the desktop app) cues the video and
 * starts it; the first answer wins.
 */
export type Verdict = 'ok' | 'blocked' | 'gone' | 'unknown'

const LS_CHECKED = 'vx_yt_checked'
const WAIT = 12000

function loadChecked(): Record<string, Verdict> {
  try {
    return JSON.parse(localStorage.getItem(LS_CHECKED) || '{}') || {}
  } catch {
    return {}
  }
}

const checked: Record<string, Verdict> = loadChecked()

function remember(id: string, v: Verdict): void {
  if (v === 'unknown') return
  checked[id] = v
  try {
    localStorage.setItem(LS_CHECKED, JSON.stringify(checked))
  } catch {
    /* checked again next time */
  }
}

/** What an earlier check (or a deck) found, without checking again. */
export function knownVerdict(id: string): Verdict | undefined {
  return checked[id]
}

/** A deck found it blocked while loading it: true (and remembered) unless every video is refused here. */
export async function confirmBlocked(id: string): Promise<boolean> {
  if (!(await playerHealthy())) return false
  remember(id, 'blocked')
  return true
}

interface Probe {
  cue(id: string): void
  play(): void
  stop(): void
}

type Listener = (state: number | null, error: number | null, videoId: string) => void

let probe: Promise<Probe> | null = null
let listener: Listener | null = null

function host(): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('aria-hidden', 'true')
  // On the page (players off-screen may be held back) but invisible and out of the way.
  el.style.cssText = 'position:fixed;left:0;bottom:0;width:240px;height:135px;opacity:0;pointer-events:none;z-index:-1;overflow:hidden'
  document.body.appendChild(el)
  return el
}

function makeProbe(): Promise<Probe> {
  if (desktop) {
    return new Promise((resolve) => {
      const channel = new BroadcastChannel('vx-yt-probe')
      channel.onmessage = (e) => {
        const m = e.data
        if (!m || m.cmd) return
        if (m.type === 'error') listener?.(null, m.code, '')
        else listener?.(m.state, null, m.videoId || '')
      }
      const view = document.createElement('webview') as any
      view.setAttribute('src', '/ytdeck.html?deck=probe')
      view.style.cssText = 'width:100%;height:100%;display:flex'
      let ready = false
      const send = (m: Record<string, unknown>) => channel.postMessage(m)
      const api: Probe = {
        cue: (id) => send({ cmd: 'cue', id }),
        play: () => send({ cmd: 'play' }),
        stop: () => send({ cmd: 'stop' }),
      }
      view.addEventListener('dom-ready', () => {
        view.setAudioMuted(true)
        if (ready) return
        ready = true
        // The page answers "ready" once its own player is up.
        const wait = (e: MessageEvent) => {
          if (e.data?.type !== 'ready') return
          channel.removeEventListener('message', wait)
          resolve(api)
        }
        channel.addEventListener('message', wait)
        const hello = window.setInterval(() => send({ cmd: 'hello' }), 300)
        channel.addEventListener('message', function stopHello(e) {
          if (e.data?.type !== 'ready') return
          window.clearInterval(hello)
          channel.removeEventListener('message', stopHello)
        })
      })
      host().appendChild(view)
    })
  }
  return loadYT().then(
    (YT) =>
      new Promise<Probe>((resolve) => {
        const el = document.createElement('div')
        host().appendChild(el)
        const player = new YT.Player(el, {
          width: '100%',
          height: '100%',
          playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
          events: {
            onReady: () => {
              player.mute()
              resolve({
                cue: (id) => player.cueVideoById(id),
                play: () => player.playVideo(),
                stop: () => player.stopVideo(),
              })
            },
            onStateChange: (e: any) => listener?.(e.data, null, player.getVideoData?.()?.video_id || ''),
            onError: (e: any) => listener?.(null, e.data, ''),
          },
        })
      }),
  )
}

let line: Promise<unknown> = Promise.resolve()

function run(id: string): Promise<Verdict> {
  return new Promise<Verdict>((resolve) => {
    let done = false
    let p: Probe | null = null
    const finish = (v: Verdict) => {
      if (done) return
      done = true
      listener = null
      window.clearTimeout(timer)
      p?.stop()
      resolve(v)
    }
    const timer = window.setTimeout(() => finish('unknown'), WAIT)
    probe ??= makeProbe()
    probe.then(
      (ready) => {
        if (done) return
        p = ready
        let cued = false
        listener = (state, error, videoId) => {
          if (error === null && videoId !== id) return // still the previous video
          if (error !== null) {
            finish(error === 101 || error === 150 ? 'blocked' : error === 100 ? 'gone' : 'unknown')
          } else if (state === 1) {
            finish('ok') // it really plays
          } else if (state === 5 && !cued) {
            cued = true
            ready.play()
          }
        }
        ready.cue(id)
        // Some players skip the "cued" report: ask it to play anyway.
        window.setTimeout(() => {
          if (!done && !cued) {
            cued = true
            ready.play()
          }
        }, 1500)
      },
      () => finish('unknown'),
    )
  })
}

function queued(id: string): Promise<Verdict> {
  const result = line.then(() => run(id))
  line = result.catch(() => undefined)
  return result
}

/**
 * YouTube's own API demo clip, always allowed everywhere. If even it is refused, it is this player's
 * setup (no referrer, a broken network), not the videos: nothing is called blocked then.
 */
const CONTROL = 'M7lc1UVf-VE'
let health: Promise<boolean> | null = null

export function playerHealthy(): Promise<boolean> {
  health ??= queued(CONTROL).then((v) => {
    if (v !== 'ok') health = null // asked again next time
    return v === 'ok'
  })
  return health
}

/** Checks one video (one at a time; answers from earlier checks come back at once). */
export async function probeYouTube(id: string): Promise<Verdict> {
  const known = checked[id]
  if (known) return known
  let v = await queued(id)
  if (v === 'blocked' && !(await playerHealthy())) v = 'unknown'
  remember(id, v)
  return v
}
