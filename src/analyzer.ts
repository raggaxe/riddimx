/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Analyzer window: measures the BPM of YouTube videos without touching the decks.
 *
 * It captures its own tab audio with local playback suppressed (so nothing is heard), plays each
 * requested video at double speed through the official player, and runs the same tempo analysis
 * used for local files on what it captured. Results go back to the app over a BroadcastChannel.
 */
import { tempoFromEnvelope, type Tempo } from './engine/analyze'
import { tapEnvelope } from './engine/envelope'
import { loadYT } from './engine/youtube'
import { ANALYZER_CHANNEL, type AnalyzerMessage } from './engine/bpm'

const SPEED = 2 // playback rate while measuring: halves the time each track takes
const LISTEN_S = 12 // real seconds captured per attempt (= 24 s of music at 2x)
const SETTLE_S = 1.5 // ignored after a seek, while the player buffers and ramps up
const MIN_CONFIDENCE = 0.08
const ATTEMPT_POSITIONS = [0.3, 0.6] // fractions of the track tried in turn

const YT_PLAYING = 1

const $ = (id: string) => document.getElementById(id) as HTMLElement
const statusEl = $('status')
const startBtn = $('start') as HTMLButtonElement
const logEl = $('log')

const channel = new BroadcastChannel(ANALYZER_CHANNEL)
const post = (m: AnalyzerMessage) => channel.postMessage(m)

let active = false
let current: string | null = null
const queue: string[] = []
let running = false

let player: any = null
let playerState = -1
let playerError: number | null = null
const stateWaiters = new Set<() => void>()

let envRate = 0
let env = new Float32Array(0)
let count = 0
let collecting = false

function setStatus(text: string, error = false): void {
  statusEl.textContent = text
  statusEl.classList.toggle('error', error)
}

function log(text: string): void {
  const li = document.createElement('li')
  li.textContent = text
  logEl.prepend(li)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const announce = () => post({ type: 'status', active, current })

/** Resolves when the player reaches `state`; rejects on player error or timeout. */
function waitForState(state: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (playerError !== null) done(() => reject(new Error('player error ' + playerError)))
      else if (playerState === state) done(resolve)
    }
    const done = (fn: () => void) => {
      clearTimeout(timer)
      stateWaiters.delete(check)
      fn()
    }
    const timer = setTimeout(() => done(() => reject(new Error('timeout'))), timeoutMs)
    stateWaiters.add(check)
    check()
  })
}

async function ensurePlayer(videoId: string): Promise<void> {
  playerError = null
  if (player) {
    player.loadVideoById(videoId)
    return
  }
  const YT = await loadYT()
  await new Promise<void>((resolve) => {
    const el = document.createElement('div')
    $('player').appendChild(el)
    player = new YT.Player(el, {
      width: '100%',
      height: '100%',
      videoId,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: () => {
          player.setVolume(100)
          player.playVideo()
          resolve()
        },
        onStateChange: (e: any) => {
          playerState = e.data
          stateWaiters.forEach((fn) => fn())
        },
        onError: (e: any) => {
          playerError = e.data
          stateWaiters.forEach((fn) => fn())
        },
      },
    })
  })
}

/** Captures LISTEN_S seconds starting at `position` and returns the tempo in original-speed BPM. */
async function measure(position: number): Promise<Tempo | null> {
  player.seekTo(position, true)
  player.setPlaybackRate(SPEED)
  player.playVideo()
  await waitForState(YT_PLAYING, 15000)
  await sleep(SETTLE_S * 1000)
  count = 0
  collecting = true
  await sleep(LISTEN_S * 1000)
  collecting = false
  const speed: number = player.getPlaybackRate() || 1
  // The capture ran `speed` times faster than the music: stretch the time base back.
  return tempoFromEnvelope(env.subarray(0, count), envRate / speed)
}

async function analyse(ref: string): Promise<number | null> {
  const videoId = ref.slice('youtube:'.length)
  playerState = -1
  await ensurePlayer(videoId)
  await waitForState(YT_PLAYING, 20000)
  const duration: number = player.getDuration() || 0
  const title: string = player.getVideoData?.()?.title || videoId
  let best: Tempo | null = null
  for (const fraction of ATTEMPT_POSITIONS) {
    const position = duration > 90 ? duration * fraction : duration > 40 ? 10 : 0
    const tempo = await measure(position)
    if (tempo && (!best || tempo.confidence > best.confidence)) best = tempo
    if (best && best.confidence >= MIN_CONFIDENCE * 2) break // clear beat: no need for a second look
    if (duration <= 90) break
  }
  player.pauseVideo()
  const ok = best !== null && best.confidence >= MIN_CONFIDENCE
  log(
    best
      ? `${ok ? '✓' : '✗'} ${title}: ${best.bpm} BPM (confidence ${best.confidence.toFixed(2)})`
      : `✗ ${title}: no audio signal`,
  )
  return ok ? best!.bpm : null
}

async function pump(): Promise<void> {
  if (running || !active) return
  running = true
  while (queue.length && active) {
    const ref = queue.shift()!
    current = ref
    announce()
    setStatus(`Analysing… (${queue.length} queued)`)
    let bpm: number | null = null
    try {
      bpm = await analyse(ref)
    } catch (e) {
      log(`✗ ${ref}: ${(e as Error).message}`)
      player?.pauseVideo?.()
    }
    post({ type: 'result', ref, bpm })
  }
  current = null
  running = false
  announce()
  if (active) setStatus('Ready. Waiting for clips.')
}

channel.onmessage = (e) => {
  const m = e.data as AnalyzerMessage
  if (m.type === 'hello') announce()
  else if (m.type === 'analyze') {
    for (const ref of m.refs) {
      if (ref === current) continue
      const at = queue.indexOf(ref)
      if (at >= 0) {
        if (!m.urgent) continue
        queue.splice(at, 1)
      }
      if (m.urgent) queue.unshift(ref)
      else queue.push(ref)
    }
    void pump()
  }
}

startBtn.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 1 },
      audio: {
        suppressLocalAudioPlayback: true, // capture the tab's sound without playing it on the speakers
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
    } as DisplayMediaStreamOptions)
    const audio = stream.getAudioTracks()[0]
    if (!audio) {
      stream.getTracks().forEach((t) => t.stop())
      setStatus('No audio. Try again: pick this tab and turn on "share tab audio".', true)
      return
    }
    stream.getVideoTracks().forEach((t) => (t.enabled = false))
    const ctx = new AudioContext()
    await ctx.resume()
    const tap = await tapEnvelope(ctx, stream, (chunk) => {
      if (!collecting || count + chunk.length > env.length) return
      env.set(chunk, count)
      count += chunk.length
    })
    envRate = tap.rate
    env = new Float32Array(Math.ceil(envRate * (LISTEN_S + 2)))
    audio.addEventListener('ended', () => {
      active = false
      collecting = false
      tap.stop()
      player?.pauseVideo?.()
      startBtn.hidden = false
      announce()
      setStatus('Sharing ended. Click Enable to resume.', true)
    })
    active = true
    startBtn.hidden = true
    $('help').hidden = true
    setStatus('Ready. Waiting for clips.')
    announce()
    void pump()
  } catch {
    setStatus('Sharing cancelled. Click Enable and accept the browser\'s request.', true)
  }
})

setInterval(announce, 2000) // heartbeat: the app notices when this window closes
window.addEventListener('pagehide', () => post({ type: 'status', active: false, current: null }))
announce()
