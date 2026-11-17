import { useEffect, useRef, useState } from 'react'
import type { Deck } from '../engine/deck'
import { useStore } from '../store'

/** Degrees the platter turns per second of music (33⅓ rpm, like a record). */
const DEG_PER_SEC = 200
const HOTCUE_COLORS = ['#e5484d', '#4aa8ff', '#c77dff', '#ff8a3d']
/** Seconds of play left at which the ring turns red. */
const END_WARNING = 30
const R = 48 // ring radius in the 100×100 viewBox
const LENGTH = 2 * Math.PI * R

/**
 * Turntable platter. It spins with the music; drag it round to nudge the tempo while playing,
 * or to move through the track while stopped. The ring around it fills with the track's progress,
 * with ticks at the cue and hot cues, and turns red near the end.
 */
export function Jog({ deck }: { deck: Deck }) {
  const s = useStore(deck)
  const disc = useRef<HTMLDivElement>(null)
  const ring = useRef<SVGCircleElement>(null)
  const last = useRef<number | null>(null)
  const [touched, setTouched] = useState(false)

  useEffect(() => {
    let raf = 0
    const spin = () => {
      raf = requestAnimationFrame(spin)
      const pos = deck.getPosition()
      if (disc.current) disc.current.style.transform = `rotate(${(pos * DEG_PER_SEC) % 360}deg)`
      const st = deck.get()
      const c = ring.current
      if (c) {
        const done = st.duration > 0 ? Math.min(1, pos / st.duration) : 0
        c.style.strokeDashoffset = String(LENGTH * (1 - done))
        const left = (st.duration - pos) / (st.rate || 1)
        const ending = st.playing && st.duration > 0 && left < END_WARNING
        c.classList.toggle('ending', ending)
        c.classList.toggle('blink', ending && Math.floor(performance.now() / 500) % 2 === 0)
      }
    }
    raf = requestAnimationFrame(spin)
    return () => cancelAnimationFrame(raf)
  }, [deck])

  const angle = (e: React.PointerEvent<HTMLDivElement>): number => {
    const r = e.currentTarget.getBoundingClientRect()
    return (Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180) / Math.PI
  }

  // A tick on the ring at a point of the track (0 s at 12 o'clock, clockwise).
  const tick = (t: number, color: string, key: string) => {
    if (!s.duration) return null
    const a = (t / s.duration) * 2 * Math.PI - Math.PI / 2
    const [x1, y1] = [50 + (R - 3) * Math.cos(a), 50 + (R - 3) * Math.sin(a)]
    const [x2, y2] = [50 + (R + 1.5) * Math.cos(a), 50 + (R + 1.5) * Math.sin(a)]
    return <line key={key} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} />
  }

  const release = () => {
    last.current = null
    setTouched(false)
  }

  return (
    <div
      className={'jog' + (touched ? ' touched' : '') + (s.playing ? ' spinning' : '')}
      role="slider"
      aria-label={'Disco do deck ' + deck.name + '. Rodar: acertar o tempo a tocar, andar na música parado'}
      aria-valuenow={0}
      tabIndex={0}
      title={s.playing ? 'Roda para acertar o tempo (empurrar / travar)' : 'Roda para andar na música'}
      onPointerDown={(e) => {
        if (deck.get().kind === 'none') return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer already gone */
        }
        last.current = angle(e)
        setTouched(true)
      }}
      onPointerMove={(e) => {
        if (last.current === null) return
        const now = angle(e)
        let delta = now - last.current
        if (delta > 180) delta -= 360
        if (delta < -180) delta += 360
        last.current = now
        // One full turn = 1.8 s of music, the same as the platter's own speed.
        if (delta) deck.jog(delta / 6)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') deck.jog(4)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') deck.jog(-4)
      }}
    >
      <svg className="jog-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="track" cx="50" cy="50" r={R} />
        <circle className="done" ref={ring} cx="50" cy="50" r={R} strokeDasharray={LENGTH} strokeDashoffset={LENGTH} />
        <g className="ticks">
          {s.kind !== 'none' && tick(s.cue, '#ffffff', 'cue')}
          {s.hotcues.map((t, i) => (t !== null ? tick(t, HOTCUE_COLORS[i], 'hc' + i) : null))}
        </g>
      </svg>
      <div className="jog-disc" ref={disc}>
        <i />
      </div>
      <div className="jog-hub">{deck.name}</div>
    </div>
  )
}
