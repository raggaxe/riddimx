import { useEffect, useRef } from 'react'
import { decks, type Deck } from '../engine/deck'
import { lyrics } from '../engine/lyrics'

const COLORS = ['#f2c230', '#35c46a'] // deck A gold, deck B green
const HOTCUE_COLORS = ['#e5484d', '#4aa8ff', '#c77dff', '#ff8a3d']
/** Screen pixels per second of real time. Both lanes share it, so synced decks show their beats lined up. */
const ZOOM_DEFAULT = 90
const ZOOM_MIN = 30
const ZOOM_MAX = 360
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
  const drag = useRef<{ deck: Deck; x: number; pos: number; sent: number } | null>(null)
  const zoom = useRef(savedZoom())
  const zoomShown = useRef(0) // when the zoom last changed: its value is shown for a moment

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const dpr = window.devicePixelRatio || 1
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
          g.fillText(deck.name + ' · vazio', 10 * dpr, top + laneH / 2)
          return
        }
        const pos = deck.getPosition()
        const secPerPx = (s.rate || 1) / (pxPerSec * dpr)
        const mid = top + laneH / 2
        const xOf = (t: number): number => cx + (t - pos) / secPerPx
        const tStart = pos - cx * secPerPx
        const tEnd = pos + (w - cx) * secPerPx
        const color = COLORS[lane]

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

        // Beat grid. The head of every bar (beat 1) is a line across the lane with its bar number, so two
        // decks can be lined up by eye; every 4 bars (a phrase) the line is stronger. Other beats: small ticks.
        if (s.bpm && s.anchor !== null) {
          const beat = 60 / s.bpm
          const barPx = (4 * beat) / secPerPx // screen distance between two bar heads
          const deckColour = lane === 0 ? '#f2c230' : '#35c46a'
          g.font = `700 ${8 * dpr}px -apple-system, system-ui, sans-serif`
          g.textBaseline = 'top'
          for (let k = Math.ceil((Math.max(0, tStart) - s.anchor) / beat); ; k++) {
            const t = s.anchor + k * beat
            if (t > tEnd || t > s.duration) break
            const x = Math.round(xOf(t))
            const inBar = ((k % 4) + 4) % 4
            if (inBar === 0) {
              const bar = Math.floor(k / 4) + 1 // bar 1 = the first beat found
              const phrase = ((bar - 1) % 4 + 4) % 4 === 0
              g.fillStyle = phrase ? deckColour : '#ffffff'
              g.globalAlpha = phrase ? 0.7 : 0.4
              g.fillRect(x, top, (phrase ? 2 : 1) * dpr, laneH)
              // Bar number when there is room for it (every bar zoomed in, every 4 bars zoomed out).
              if (bar >= 1 && (barPx > 26 * dpr || phrase)) {
                g.globalAlpha = phrase ? 0.9 : 0.55
                g.fillText(String(bar), x + 3 * dpr, top + 2 * dpr)
              }
            } else if (barPx > 14 * dpr) {
              g.fillStyle = '#ffffff'
              g.globalAlpha = 0.3
              const len = 4 * dpr
              g.fillRect(x, top, dpr, len)
              g.fillRect(x, top + laneH - len, dpr, len)
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
        const lines = s.duration ? lyrics.linesFor(key, s.title, s.artist, s.duration) : null
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
            g.fillText('VOZ', x + 3 * dpr, flagY + 6 * dpr)
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
            // Leave the right end to the time-left label.
            if (x + width > w - 56 * dpr) continue
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
        aria-label="Ondas dos dois decks"
        onPointerDown={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const deck = decks[e.clientY - rect.top < rect.height / 2 ? 0 : 1]
          if (deck.get().kind === 'none') return
          try {
            e.currentTarget.setPointerCapture(e.pointerId)
          } catch {
            /* pointer already gone */
          }
          drag.current = { deck, x: e.clientX, pos: deck.getPosition(), sent: 0 }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const now = performance.now()
          // Streaming players take a moment per seek: do not flood them.
          if (d.deck.get().kind !== 'local' && now - d.sent < 80) return
          d.sent = now
          const s = d.deck.get()
          const t = d.pos - ((e.clientX - d.x) / zoom.current) * (s.rate || 1)
          d.deck.seek(Math.max(0, Math.min(s.duration, t)))
        }}
        onWheel={(e) => {
          // Wheel or trackpad pinch: zoom in and out around the needle.
          const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.current * Math.exp(-e.deltaY * 0.0025)))
          if (next === zoom.current) return
          zoom.current = next
          zoomShown.current = performance.now()
          try {
            localStorage.setItem(LS_ZOOM, String(Math.round(next)))
          } catch {
            /* not remembered */
          }
        }}
        onDoubleClick={() => {
          zoom.current = ZOOM_DEFAULT
          zoomShown.current = performance.now()
          try {
            localStorage.setItem(LS_ZOOM, String(ZOOM_DEFAULT))
          } catch {
            /* not remembered */
          }
        }}
        title="Arrasta para andar na música · roda do rato para zoom · duplo clique repõe o zoom"
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      />
    </div>
  )
}
