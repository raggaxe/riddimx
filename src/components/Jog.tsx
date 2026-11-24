import { useEffect, useRef, useState } from 'react'
import { settings } from '../settings'
import type { Deck } from '../engine/deck'
import { useStore } from '../store'

/** Degrees the platter turns per second of music (33⅓ rpm, like a record). */
const DEG_PER_SEC = 200
const HOTCUE_COLORS = ['#e5484d', '#4aa8ff', '#c77dff', '#ff8a3d', '#3dd68c', '#f2c230', '#2fd3d3', '#ff6fb1']
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
  // The hand's recent path (time, total angle), to know how hard the platter was thrown.
  const trail = useRef<{ t: number; a: number }[]>([])
  const turned = useRef(0)
  const coast = useRef(0) // animation frame of a platter still spinning after it was let go

  // Let go of the platter for good: the record plays on (or stays put) from where it is.
  const letGo = () => {
    cancelAnimationFrame(coast.current)
    coast.current = 0
    deck.jogTouch(false)
  }
  useEffect(() => () => cancelAnimationFrame(coast.current), [])
  // The release is listened for on the whole window: a throw often ends with the pointer far off the platter.
  const releaseRef = useRef<() => void>(() => undefined)

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

  /**
   * Let go. Thrown hard, the platter keeps turning on its own and slows down with friction, like a
   * real one: a playing record settles back into its normal speed, a stopped one comes to rest.
   */
  const release = () => {
    window.removeEventListener('pointerup', releaseRef.current)
    window.removeEventListener('pointercancel', releaseRef.current)
    window.removeEventListener('blur', releaseRef.current)
    if (last.current === null) return
    last.current = null
    setTouched(false)
    const now = performance.now()
    const path = trail.current.filter((p) => now - p.t < 90)
    const first = path[0]
    const lastP = path[path.length - 1]
    const span = first && lastP ? (lastP.t - first.t) / 1000 : 0
    // Degrees per second at the moment it left the hand (0 if the hand had stopped).
    let vel = span > 0.01 && now - lastP.t < 60 ? (lastP.a - first.a) / span : 0
    if (!settings.get().jogInertia || deck.get().kind !== 'local' || Math.abs(vel) < 120) return letGo()
    vel = Math.max(-5000, Math.min(5000, vel))
    let before = now
    const spin = () => {
      const t = performance.now()
      const dt = Math.min(0.05, (t - before) / 1000)
      before = t
      const st = deck.get()
      const target = st.playing ? DEG_PER_SEC * (st.rate || 1) : 0 // the motor's speed, or none
      // Friction on a free platter; a playing one is also pulled back up to speed by the motor.
      vel = target + (vel - target) * Math.exp(-dt / (st.playing ? 0.28 : 0.4))
      deck.scratch((vel * dt) / 6)
      if (Math.abs(vel - target) < 30) return letGo()
      coast.current = requestAnimationFrame(spin)
    }
    coast.current = requestAnimationFrame(spin)
  }

  return (
    <div
      className={'jog tt' + (touched ? ' touched' : '') + (s.playing ? ' spinning' : '') + (s.kind === 'none' ? ' empty' : '')}
      role="slider"
      aria-label={'Deck platter ' + deck.name + '. Hold and turn: scratch'}
      aria-valuenow={0}
      tabIndex={0}
      title={
        s.kind === 'local'
          ? 'Hold and turn: scratch (the record stops under your hand and plays again when released). To fix the tempo: ‹ › buttons'
          : s.playing
            ? 'Turn to fix the tempo (push / hold back)'
            : 'Turn to move through the track'
      }
      onPointerDown={(e) => {
        if (deck.get().kind === 'none') return
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* pointer already gone */
        }
        cancelAnimationFrame(coast.current) // caught while still spinning
        coast.current = 0
        last.current = angle(e)
        turned.current = 0
        trail.current = [{ t: performance.now(), a: 0 }]
        setTouched(true)
        releaseRef.current = release
        window.addEventListener('pointerup', release)
        window.addEventListener('pointercancel', release)
        window.addEventListener('blur', release)
        // Hand on the record, as in VirtualDJ: it holds still under the pointer and scratches when moved.
        deck.jogTouch(true)
      }}
      onPointerMove={(e) => {
        if (last.current === null) return
        // Button already up (the release was missed): let go now.
        if (e.buttons === 0 && e.pointerType === 'mouse') return release()
        const now = angle(e)
        let delta = now - last.current
        if (delta > 180) delta -= 360
        if (delta < -180) delta += 360
        last.current = now
        turned.current += delta
        const t = performance.now()
        trail.current.push({ t, a: turned.current })
        if (trail.current.length > 12) trail.current.shift()
        // The record follows the pointer exactly: one full turn = 1.8 s of music, the platter's own speed.
        if (delta) deck.scratch(delta / 6)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') deck.jog(4)
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') deck.jog(-4)
      }}
    >
      {/* The plinth's progress ring: how much of the track has played, with the cue and hot cues. */}
      <svg className="jog-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="track" cx="50" cy="50" r={R} />
        <circle className="done" ref={ring} cx="50" cy="50" r={R} strokeDasharray={LENGTH} strokeDashoffset={LENGTH} />
        <g className="ticks">
          {s.kind !== 'none' && tick(s.cue, '#ffffff', 'cue')}
          {s.hotcues.map((t, i) => (t !== null ? tick(t, HOTCUE_COLORS[i], 'hc' + i) : null))}
        </g>
      </svg>
      {/* Turntable: strobe dots on the platter's edge, the record with its grooves, the cover on the label. */}
      <div className="tt-platter">
        <div className={'jog-disc tt-vinyl' + (s.cover ? ' art' : '')} ref={disc}>
          {/* With a cover, the whole record is the picture (a picture disc), grooves shining over it. */}
          {s.cover && <img className="tt-art" key={s.cover} src={s.cover} alt="" draggable={false} />}
          <div className="tt-label">
            {!s.cover && <b>{s.kind === 'none' ? deck.name : 'RIDDIM'}</b>}
            <i className="tt-mark" />
          </div>
        </div>
        <span className="tt-spindle" />
      </div>
      {/* Tone arm: rests outside with no record, on the record once a track is loaded. */}
      <svg className={'tt-arm' + (s.kind !== 'none' ? ' on' : '')} viewBox="0 0 40 100" aria-hidden="true">
        <circle className="tt-pivot" cx="30" cy="12" r="7" />
        <circle className="tt-pivot-in" cx="30" cy="12" r="3" />
        <path className="tt-tube" d="M30 12 L30 70 L22 86" />
        <rect className="tt-head" x="16" y="84" width="10" height="13" rx="1.5" transform="rotate(28 21 90)" />
      </svg>
    </div>
  )
}
