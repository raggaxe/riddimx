import { useEffect, useRef, useState } from 'react'
import { settings } from '../settings'
import { uiScale } from '../ui'
import { decks, type Deck } from '../engine/deck'
import { LYRICS_ON, lyrics } from '../engine/lyrics'
import { useStore } from '../store'

const HOTCUE_COLORS = ['#e5484d', '#4aa8ff', '#c77dff', '#ff8a3d', '#3dd68c', '#f2c230', '#2fd3d3', '#ff6fb1']
/** Screen pixels per second of real time. Both lanes share it, so synced decks show their beats lined up. */
const ZOOM_DEFAULT = 90
const ZOOM_MIN = 3 // about a whole track across the window
const ZOOM_MAX = 1200 // a single beat spread wide
const LS_ZOOM = 'vx_wave_zoom'
/** Under this many seconds left, a playing deck's remaining time turns red. */
const END_WARNING = 30

function savedZoom(): number {
  try {
    const z = Number(localStorage.getItem(LS_ZOOM))
    return z >= ZOOM_MIN && z <= ZOOM_MAX ? z : ZOOM_DEFAULT
  } catch {
    return ZOOM_DEFAULT
  }
}

const clock = (s: number): string => {
  const t = Math.max(0, s)
  return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0')
}

/**
 * The two decks' waveforms scrolling under a fixed centre playhead, one above the other,
 * with beat marks, cue points and (when found) the lyrics. Drag a lane to move through its track.
 */
export function TrackView() {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{ deck: Deck; x: number; y: number; pos: number; sent: number; moved: boolean } | null>(null)
  const zoom = useRef(savedZoom())
  const zoomShown = useRef(0) // when the zoom last changed: its value is shown for a moment
  const [zoomPct, setZoomPct] = useState(() => Math.round((zoom.current / ZOOM_DEFAULT) * 100))
  /** One place for every zoom change: wheel, buttons, reset. */
  const setZoom = (next: number) => {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next))
    if (z === zoom.current) return
    zoom.current = z
    zoomShown.current = performance.now()
    setZoomPct(Math.round((z / ZOOM_DEFAULT) * 100))
    try {
      localStorage.setItem(LS_ZOOM, String(Math.round(z * 10) / 10))
    } catch {
      /* not remembered */
    }
  }

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      // Canvas pixels per CSS pixel; in a browser the app's own zoom counts too, so it stays sharp.
      const dpr = (window.devicePixelRatio || 1) * uiScale()
      const w = Math.round(c.clientWidth * dpr)
      const h = Math.round(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      const g = c.getContext('2d')
      if (!g) return
      g.clearRect(0, 0, w, h)
      const cx = Math.round(w / 2)
      const laneH = h / 2
      const step = Math.max(1, Math.round(2 * dpr))
      const pxPerSec = zoom.current
      const now = performance.now()
      const font = (size: number, weight = 600) => `${weight} ${size * dpr}px -apple-system, system-ui, sans-serif`

      // Lane backgrounds: each deck's strip faintly tinted with its colour.
      g.fillStyle = 'rgba(242, 194, 48, 0.035)'
      g.fillRect(0, 0, w, laneH)
      g.fillStyle = 'rgba(53, 196, 106, 0.03)'
      g.fillRect(0, laneH, w, laneH)

      decks.forEach((deck, lane) => {
        const s = deck.get()
        const top = lane * laneH
        if (s.kind === 'none') {
          g.font = font(10)
          g.textBaseline = 'middle'
          g.fillStyle = 'rgba(255, 255, 255, 0.22)'
          g.fillText(deck.name + ' · empty', 10 * dpr, top + laneH / 2)
          return
        }
        const pos = deck.getPosition()
        const secPerPx = (s.rate || 1) / (pxPerSec * dpr)
        const mid = top + laneH / 2
        const xOf = (t: number): number => cx + (t - pos) / secPerPx
        const tStart = pos - cx * secPerPx
        const tEnd = pos + (w - cx) * secPerPx
        const color = lane === 0 ? settings.get().colorA : settings.get().colorB

        // Before the start and after the end of the track: darker, so its edges are seen coming.
        g.fillStyle = 'rgba(0, 0, 0, 0.35)'
        if (xOf(0) > 0) g.fillRect(0, top, Math.min(w, xOf(0)), laneH)
        if (s.duration && xOf(s.duration) < w) g.fillRect(Math.max(0, xOf(s.duration)), top, w - Math.max(0, xOf(s.duration)), laneH)

        if (s.loop) {
          g.fillStyle = 'rgba(76, 217, 123, 0.18)'
          g.fillRect(xOf(s.loop.in), top, xOf(s.loop.out) - xOf(s.loop.in), laneH)
        }

        const detail = deck.detail()
        g.fillStyle = color
        if (detail) {
          const { data, rate, top: full } = detail
          for (let x = 0; x < w; x += step) {
            const t0 = tStart + x * secPerPx
            if (t0 < 0 || t0 > s.duration) continue
            const i0 = Math.max(0, Math.floor(t0 * rate))
            const i1 = Math.min(data.length, Math.max(i0 + 1, Math.ceil((t0 + step * secPerPx) * rate)))
            let peak = 0
            for (let i = i0; i < i1; i++) if (data[i] > peak) peak = data[i]
            const level = Math.min(1, peak / full)
            const bar = Math.max(dpr, level * laneH * 0.86)
            const width = step - (step > 1 ? 1 : 0)
            const played = x < cx
            // Outer shape faint, loud core solid: quiet passages and drops read at a glance.
            g.globalAlpha = played ? 0.22 : 0.5
            g.fillRect(x, mid - bar / 2, width, bar)
            const core = bar * (0.35 + 0.4 * level)
            g.globalAlpha = played ? 0.4 : 1
            g.fillRect(x, mid - core / 2, width, core)
          }
          g.globalAlpha = 1
        } else {
          g.globalAlpha = 0.5
          g.fillRect(Math.max(0, xOf(0)), mid - dpr / 2, Math.min(w, xOf(s.duration)) - Math.max(0, xOf(0)), dpr)
          g.globalAlpha = 1
        }

        // Beat grid, VirtualDJ style: the head of every bar is a small square in the deck's colour on the
        // lane's inner edge (where the two lanes meet), with a faint line through the wave so two decks
        // can be lined up by eye; every 4 bars (a phrase) the square is bigger and numbered. Other beats:
        // a tiny tick on that edge. Bars are counted from the start of the track.
        if (s.bpm && s.anchor !== null) {
          const beat = 60 / s.bpm
          const barLen = 4 * beat
          const barPx = barLen / secPerPx // screen distance between two bar heads
          const one = s.barAt ?? s.anchor // the one: found or marked (Shift+TAP), else the grid's own beat
          const firstBar = one - Math.floor(one / barLen + 1e-6) * barLen
          const inner = lane === 0 ? top + laneH : top // the edge facing the other lane
          const sq = Math.max(4 * dpr, Math.min(7 * dpr, laneH * 0.16))
          const labelSize = Math.max(7, Math.min(9, laneH / dpr / 2.8))
          g.font = `700 ${labelSize * dpr}px -apple-system, system-ui, sans-serif`
          g.textBaseline = lane === 0 ? 'bottom' : 'top'
          for (let k = Math.ceil((Math.max(0, tStart) - firstBar) / beat - 1e-6); ; k++) {
            const t = firstBar + k * beat
            if (t > tEnd || t > s.duration) break
            if (t < 0) continue
            const x = Math.round(xOf(t))
            if (((k % 4) + 4) % 4 === 0) {
              const bar = Math.round(k / 4) + 1
              const phrase = (bar - 1) % 4 === 0
              const size = phrase ? sq * 1.35 : sq
              g.fillStyle = color
              g.globalAlpha = phrase ? 0.35 : 0.18
              g.fillRect(x, top, dpr, laneH)
              g.globalAlpha = 1
              g.fillRect(x - size / 2, lane === 0 ? inner - size - dpr : inner + dpr, size, size)
              // Bar number beside the square: every phrase, or every bar when zoomed in enough.
              if ((phrase && barPx * 4 > 26 * dpr) || barPx > 34 * dpr) {
                g.globalAlpha = phrase ? 0.95 : 0.6
                g.fillText(String(bar), x + size / 2 + 2 * dpr, lane === 0 ? inner - dpr : inner + dpr)
              }
            } else if (barPx > 14 * dpr) {
              g.fillStyle = '#ffffff'
              g.globalAlpha = 0.35
              const len = Math.max(2 * dpr, sq * 0.45)
              g.fillRect(x, lane === 0 ? inner - len - dpr : inner + dpr, dpr, len)
            }
          }
          g.globalAlpha = 1
          g.textBaseline = 'alphabetic'
        }

        g.font = `800 ${7.5 * dpr}px -apple-system, system-ui, sans-serif`
        g.textBaseline = 'middle'
        const marker = (t: number, fill: string, label: string) => {
          if (t < tStart || t > tEnd) return
          const x = Math.round(xOf(t))
          g.fillStyle = fill
          g.globalAlpha = 0.85
          g.fillRect(x, top, 1.5 * dpr, laneH)
          g.globalAlpha = 1
          // A small flag on the outer edge of the lane (top for A, bottom for B), out of the waveform's way.
          const fy = lane === 0 ? top : top + laneH - 10 * dpr
          g.fillRect(x, fy, 10 * dpr, 10 * dpr)
          g.fillStyle = '#111'
          g.fillText(label, x + 2.5 * dpr, fy + 5.5 * dpr)
        }
        marker(s.cue, '#ffffff', 'C')
        s.hotcues.forEach((t, i) => t !== null && marker(t, HOTCUE_COLORS[i], String(i + 1)))

        // Lyrics ride along the waveform at the moment they are sung.
        const key = s.ref ?? 'file:' + s.title
        const lines = LYRICS_ON && s.duration ? lyrics.linesFor(key, s.title, s.artist, s.duration) : null
        if (lines?.length) {
          // Where the voice comes in: a small flag on the lane, handy to mix a riddim before the singing.
          const vin = lines[0].time
          if (vin >= tStart && vin <= tEnd) {
            const x = Math.round(xOf(vin))
            const flagY = lane === 0 ? top + laneH - 13 * dpr : top + dpr
            g.fillStyle = 'rgba(143, 209, 143, 0.9)'
            g.fillRect(x, top, dpr, laneH)
            g.fillRect(x, flagY, 26 * dpr, 12 * dpr)
            g.fillStyle = '#0b0a08'
            g.font = `800 ${8 * dpr}px -apple-system, system-ui, sans-serif`
            g.textBaseline = 'middle'
            g.fillText('VOX', x + 3 * dpr, flagY + 6 * dpr)
          }
          g.font = `600 ${10 * dpr}px -apple-system, system-ui, sans-serif`
          g.textBaseline = 'middle'
          let free = -Infinity
          for (const line of lines) {
            if (line.time < tStart - 8) continue
            if (line.time > tEnd) break
            const x = xOf(line.time)
            if (x < free) continue
            const width = g.measureText(line.text).width
            // Leave the right end to the time-left label and the lyrics' timing buttons.
            if (x + width > w - 150 * dpr) continue
            const y = lane === 0 ? top + 9 * dpr : top + laneH - 9 * dpr
            g.fillStyle = 'rgba(8, 10, 14, 0.72)'
            g.fillRect(x - 3 * dpr, y - 7 * dpr, width + 6 * dpr, 14 * dpr)
            g.fillStyle = x < cx ? '#ffffff' : '#c9d1e0'
            g.fillText(line.text, x, y)
            free = x + width + 14 * dpr
          }
        }

        // Deck letter on the left; time left on the right, red near the end of a playing track.
        g.textBaseline = 'middle'
        const tempo = s.bpm ? (s.bpm * s.rate).toFixed(1) : ''
        g.font = font(9, 700)
        const tagW = (tempo ? 20 + g.measureText(tempo).width / dpr + 6 : 18) * dpr
        g.fillStyle = 'rgba(10, 9, 7, 0.82)'
        g.fillRect(0, mid - 8 * dpr, tagW, 16 * dpr)
        g.fillStyle = color
        g.globalAlpha = 0.18
        g.fillRect(3 * dpr, mid - 6 * dpr, 12 * dpr, 12 * dpr)
        g.globalAlpha = 1
        g.font = font(9, 800)
        g.fillText(deck.name, 5.5 * dpr, mid + 0.5 * dpr)
        if (tempo) {
          g.font = font(9, 700)
          g.fillText(tempo, 19 * dpr, mid + 0.5 * dpr)
        }
        if (s.duration) {
          const left = (s.duration - pos) / (s.rate || 1)
          const ending = s.playing && left < END_WARNING
          const text = '−' + clock(left)
          g.font = font(9.5, 700)
          const tw = g.measureText(text).width
          g.fillStyle = 'rgba(10, 9, 7, 0.75)'
          g.fillRect(w - tw - 12 * dpr, mid - 8 * dpr, tw + 12 * dpr, 16 * dpr)
          g.fillStyle = ending ? (Math.floor(now / 500) % 2 ? '#e5484d' : '#ff8a8d') : 'rgba(236, 230, 216, 0.75)'
          g.fillText(text, w - tw - 6 * dpr, mid)
        }
      })

      g.fillStyle = 'rgba(255, 255, 255, 0.08)'
      g.fillRect(0, laneH - dpr / 2, w, dpr)
      g.fillStyle = 'rgba(229, 72, 77, 0.18)' // a soft glow around the needle
      g.fillRect(cx - 4 * dpr, 0, 8 * dpr, h)
      g.fillStyle = '#e5484d' // the needle, with small arrows top and bottom
      g.fillRect(cx - dpr, 0, 2 * dpr, h)
      const arrow = 5 * dpr
      g.beginPath()
      g.moveTo(cx - arrow, 0)
      g.lineTo(cx + arrow, 0)
      g.lineTo(cx, arrow)
      g.moveTo(cx - arrow, h)
      g.lineTo(cx + arrow, h)
      g.lineTo(cx, h - arrow)
      g.fill()

      // Zoom level, for a moment after it changes.
      const since = now - zoomShown.current
      if (since < 1200) {
        const text = Math.round((pxPerSec / ZOOM_DEFAULT) * 100) + '%'
        g.font = font(10, 700)
        g.textBaseline = 'middle'
        const tw = g.measureText(text).width
        g.globalAlpha = Math.min(1, (1200 - since) / 300)
        g.fillStyle = 'rgba(10, 9, 7, 0.85)'
        g.fillRect(cx + 8 * dpr, laneH - 9 * dpr, tw + 12 * dpr, 18 * dpr)
        g.fillStyle = '#ece6d8'
        g.fillText(text, cx + 14 * dpr, laneH)
        g.globalAlpha = 1
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="trackview">
      <canvas
        ref={canvas}
        aria-label="Waveforms of both decks"
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const deck = decks[e.clientY - rect.top < rect.height / 2 ? 0 : 1]
          if (deck.get().kind === 'none') return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* pointer already gone */
          }
          drag.current = { deck, x: e.clientX, y: e.clientY, pos: deck.getPosition(), sent: 0, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          // A few pixels of wobble is still a click (a cue), not a drag.
          if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
          d.moved = true
          const now = performance.now()
          // Streaming players take a moment per seek: do not flood them.
          if (d.deck.get().kind !== 'local' && now - d.sent < 80) return
          d.sent = now
          const s = d.deck.get()
          const t = d.pos - ((e.clientX - d.x) / uiScale() / zoom.current) * (s.rate || 1)
          const to = Math.max(0, Math.min(s.duration, t))
          // Stopped: the head of a bar pulls a little, so cueing on the one is easy.
          d.deck.seek(s.playing ? to : d.deck.magnet(to))
        }}
        onWheel={(e) => {
          // Wheel or trackpad pinch: zoom in and out around the needle.
          setZoom(zoom.current * Math.exp(-e.deltaY * 0.0025))
        }}
        onClick={(e) => {
          if (e.altKey) setZoom(ZOOM_DEFAULT)
        }}
        title="Click: set the CUE there · drag: move through the track · wheel / pinch: zoom · Option+click: reset zoom"
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          if (!d || d.moved || e.altKey) return
          // A click: the CUE goes where the waveform was clicked (same scale the lane is drawn at).
          const rect = e.currentTarget.getBoundingClientRect()
          const s = d.deck.get()
          d.deck.cueAt(d.deck.getPosition() + ((e.clientX - rect.left - rect.width / 2) / uiScale() / zoom.current) * (s.rate || 1))
        }}
        onPointerCancel={() => (drag.current = null)}
      />
      {LYRICS_ON && decks.map((deck, i) => <LyricsTiming key={deck.name} deck={deck} lane={i} />)}
      <div className="tv-zoom" role="group" aria-label="Waveform zoom">
        <button onClick={() => setZoom(zoom.current / 1.6)} disabled={zoom.current <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (see more of the track)">
          −
        </button>
        <button className="tv-zoom-read" onClick={() => setZoom(ZOOM_DEFAULT)} title="Back to 100%">
          {zoomPct}%
        </button>
        <button onClick={() => setZoom(zoom.current * 1.6)} disabled={zoom.current >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (see more detail)">
          +
        </button>
      </div>
    </div>
  )
}

/** Shown when a deck has lyrics: moves them earlier / later, 0.1 s a click (Shift: 1 s), and back to automatic. */
function LyricsTiming({ deck, lane }: { deck: Deck; lane: number }) {
  const s = useStore(deck)
  const l = useStore(lyrics)
  const key = s.ref ?? 'file:' + s.title
  if (s.kind === 'none' || !l.lines[key]?.length) return null
  const offset = lyrics.offsetOf(key)
  const hand = l.fit[key] === 'hand'
  const step = (e: React.MouseEvent, dir: 1 | -1) => lyrics.nudge(key, dir * (e.shiftKey ? 1 : 0.1))
  return (
    <div className={'lyr-timing ' + (lane === 0 ? 'top' : 'bottom')}>
      <span title={hand ? 'Set by hand' : offset ? 'Lined up with the voice by itself' : 'Original lyric timing'}>
        LYRICS {offset > 0 ? '+' : offset < 0 ? '−' : ''}
        {Math.abs(offset).toFixed(1)}s
      </span>
      <button
        onClick={(e) => step(e, -1)}
        title="Lyrics earlier (0.1 s · Shift: 1 s)"
        aria-label={'Lyrics of deck ' + deck.name + ' earlier'}
      >
        ◀
      </button>
      <button
        onClick={(e) => step(e, 1)}
        title="Lyrics later (0.1 s · Shift: 1 s)"
        aria-label={'Lyrics of deck ' + deck.name + ' later'}
      >
        ▶
      </button>
      {hand && (
        <button onClick={() => lyrics.resetTiming(key)} title="Back to automatic timing" aria-label="Automatic timing">
          AUTO
        </button>
      )}
    </div>
  )
}
