import { useEffect, useRef } from 'react'
import { settings } from '../settings'
import { uiScale } from '../ui'
import type { Deck } from '../engine/deck'

const HOTCUE_COLORS = ['#e5484d', '#4aa8ff', '#c77dff', '#ff8a3d', '#3dd68c', '#f2c230', '#2fd3d3', '#ff6fb1']
/** Seconds of play left at which the remaining time turns red. */
const END_WARNING = 30

function fmt(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  return m + ':' + (s - m * 60).toFixed(1).padStart(4, '0')
}

/** Overview waveform (or plain progress bar for streaming sources) drawn every frame; click/drag to seek. */
export function Waveform({ deck, children, info }: { deck: Deck; children?: React.ReactNode; info?: React.ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const elapsed = useRef<HTMLSpanElement>(null)
  const remaining = useRef<HTMLSpanElement>(null)
  const total = useRef<HTMLSpanElement>(null)
  const counter = useRef<HTMLSpanElement>(null)

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
      const s = deck.get()
      const pos = deck.getPosition()
      const dur = s.duration
      const x = (t: number) => (dur > 0 ? (t / dur) * w : 0)
      const px = x(pos)
      const color = deck.side === 0 ? settings.get().colorA : settings.get().colorB
      g.clearRect(0, 0, w, h)

      // The last 30 s of the track are tinted, so the end never comes by surprise.
      if (dur > 60) {
        g.fillStyle = 'rgba(229, 72, 77, 0.10)'
        g.fillRect(x(dur - END_WARNING * (s.rate || 1)), 0, w, h)
      }

      if (s.peaks) {
        const n = s.peaks.length
        const bw = w / n
        for (let i = 0; i < n; i++) {
          const bx = i * bw
          const bh = Math.max(dpr, s.peaks[i] * h * 0.92)
          g.fillStyle = bx < px ? '#5a5346' : color
          g.fillRect(bx, (h - bh) / 2, Math.max(1, bw - 0.5), bh)
        }
      } else if (dur > 0) {
        g.fillStyle = '#2a261d'
        g.fillRect(0, h * 0.42, w, h * 0.16)
        g.fillStyle = color
        g.fillRect(0, h * 0.42, px, h * 0.16)
      }

      if (s.loop) {
        g.fillStyle = 'rgba(76, 217, 123, 0.25)'
        g.fillRect(x(s.loop.in), 0, Math.max(2, x(s.loop.out) - x(s.loop.in)), h)
      }
      if (dur > 0) {
        g.fillStyle = '#ffffff'
        g.fillRect(x(s.cue) - dpr, h - 6 * dpr, 2 * dpr, 6 * dpr)
        s.hotcues.forEach((t, i) => {
          if (t === null) return
          g.fillStyle = HOTCUE_COLORS[i]
          g.fillRect(x(t) - dpr, 0, 2 * dpr, h)
        })
        g.fillStyle = '#ffffff'
        g.fillRect(px - dpr, 0, 2 * dpr, h)
      }

      // Beat light: flashes on every beat of this deck's grid, so alignment between decks is visible.
      if (s.anchor !== null && s.bpm && s.playing) {
        const beat = 60 / s.bpm
        const phase = ((((pos - s.anchor) / beat) % 1) + 1) % 1
        g.globalAlpha = Math.max(0, 1 - phase * 3)
        g.fillStyle = '#ffffff'
        g.beginPath()
        g.arc(w - 10 * dpr, 10 * dpr, 5 * dpr, 0, Math.PI * 2)
        g.fill()
        g.globalAlpha = 1
      }

      if (elapsed.current) elapsed.current.textContent = dur > 0 ? fmt(pos) : '0:00.0'
      if (total.current) total.current.textContent = dur > 0 ? fmt(dur / (s.rate || 1)) : '0:00.0'
      const left = (dur - pos) / (s.rate || 1)
      if (remaining.current) {
        remaining.current.textContent = dur > 0 ? fmt(left) : '0:00.0'
        const ending = s.playing && dur > 0 && left < END_WARNING
        remaining.current.classList.toggle('ending', ending)
        remaining.current.classList.toggle('blink', ending && Math.floor(performance.now() / 500) % 2 === 0)
      }
      // Bar and beat (counted in bars of 4 from the grid), to count phrases.
      if (counter.current) {
        if (s.anchor !== null && s.bpm && dur > 0) {
          const beats = Math.floor((pos - s.anchor) / (60 / s.bpm))
          const bar = Math.floor(beats / 4) + 1
          const beat = (((beats % 4) + 4) % 4) + 1
          counter.current.textContent = bar > 0 ? bar + '.' + beat : ''
          counter.current.classList.toggle('downbeat', beat === 1 && bar % 4 === 1)
        } else counter.current.textContent = ''
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [deck])

  const seekTo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const dur = deck.get().duration
    if (dur > 0) deck.seek(((e.clientX - rect.left) / rect.width) * dur)
  }

  return (
    <div className="wave">
      <div className="wave-box">
        <canvas
          ref={canvas}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            seekTo(e)
          }}
          onPointerMove={(e) => {
            if (e.buttons & 1) seekTo(e)
          }}
        />
        {children}
      </div>
      {/* Info line: time played · left · whole track (at the current pitch), then the deck's key and tempo tools. */}
      <div className="times">
        <span className="t-cell">
          <small>ELAPSED</small>
          <span className="t-elapsed" ref={elapsed}>
            0:00.0
          </span>
        </span>
        <span className="t-cell">
          <small>REMAINING</small>
          <span className="t-left" ref={remaining}>
            0:00.0
          </span>
        </span>
        <span className="t-cell t-total">
          <small>TOTAL</small>
          <span ref={total}>0:00.0</span>
        </span>
        <span className="t-bar" ref={counter} title="Bar.beat (bars 1, 5, 9… start a phrase)" />
        {info}
      </div>
    </div>
  )
}
