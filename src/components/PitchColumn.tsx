import { useEffect, useRef, useState } from 'react'
import type { Deck } from '../engine/deck'
import { useStore } from '../store'

/** Pitch fader ranges, in %. Marks top to bottom: slower at the top, faster at the bottom (like a turntable). */
const RANGES = [8, 16, 50] as const
const marksFor = (r: number) => {
  const half = String(r / 2)
  return ['−' + r, null, '−' + half, null, '0', null, '+' + half, null, '+' + r]
}
const savedRange = (name: string): number => {
  try {
    const r = Number(localStorage.getItem('vx_pitch_range_' + name))
    return (RANGES as readonly number[]).includes(r) ? r : 8
  } catch {
    return 8
  }
}

/**
 * Pitch of one deck, as its own strip between the deck and the mixer: readout and range on top,
 * the long fader, then the actions (nudge − / +, key lock).
 */
export function PitchColumn({ deck }: { deck: Deck }) {
  const s = useStore(deck)
  const [range, setRange] = useState(() => savedRange(deck.name))
  const nextRange = () => {
    const next = RANGES[(RANGES.indexOf(range as (typeof RANGES)[number]) + 1) % RANGES.length]
    setRange(next)
    try {
      localStorage.setItem('vx_pitch_range_' + deck.name, String(next))
    } catch {
      /* not remembered */
    }
  }
  const pitch = (s.rate - 1) * 100
  const locked = s.kind === 'youtube' || (s.keyLock && deck.canKeyLock)
  const shift = deck.keyShift

  // Bend buttons: the longer they are held, the harder they push or hold back (2% growing to 8% in a second).
  const [bending, setBending] = useState(0)
  const bendRun = useRef(0)
  const bendStart = (dir: number) => {
    if (!deck.canPitch) return
    cancelAnimationFrame(bendRun.current)
    const start = performance.now()
    const step = () => {
      const t = (performance.now() - start) / 1000
      deck.setBend(1 + dir * Math.min(0.08, 0.02 + 0.06 * t))
      bendRun.current = requestAnimationFrame(step)
    }
    step()
    setBending(dir)
  }
  const bendStop = () => {
    cancelAnimationFrame(bendRun.current)
    deck.setBend(1)
    setBending(0)
  }
  useEffect(() => () => cancelAnimationFrame(bendRun.current), [])
  const bend = (dir: number) => ({
    className: bending === dir ? 'held' : '',
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      if (e.button !== 0) return
      e.currentTarget.setPointerCapture(e.pointerId)
      bendStart(dir)
    },
    onPointerUp: bendStop,
    onPointerCancel: bendStop,
    onLostPointerCapture: bendStop,
    onKeyDown: (e: React.KeyboardEvent) => {
      if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
        e.preventDefault()
        bendStart(dir)
      }
    },
    onKeyUp: (e: React.KeyboardEvent) => (e.key === ' ' || e.key === 'Enter') && bendStop(),
    onBlur: () => bending === dir && bendStop(),
  })

  const marks = marksFor(range)
  return (
    <div className={'pc pc-' + deck.name.toLowerCase()} role="group" aria-label={'Pitch of deck ' + deck.name}>
      <button
        className={'pc-read' + (Math.abs(pitch) < 0.05 ? ' zero' : '') + (s.syncOn ? ' synced' : '')}
        disabled={!deck.canPitch || Math.abs(pitch) < 0.05}
        onClick={() => deck.setRate(1)}
        title={s.syncOn ? 'Tempo followed by SYNC' : 'Pitch in %. Click to go back to 0'}
        aria-label={'Pitch ' + pitch.toFixed(1) + '%. Back to zero'}
      >
        {s.syncOn ? 'SYNC' : (pitch >= 0.05 ? '+' : pitch <= -0.05 ? '−' : '') + Math.abs(pitch).toFixed(1)}
        {!s.syncOn && <small>%</small>}
      </button>
      <button className="pc-range" onClick={nextRange} disabled={!deck.canPitch} title="Pitch range: click to change (8, 16 or 50%)">
        ±{range}
      </button>
      <div className="pc-fader">
        {/* Marks share the thumb's travel exactly: the same padding as half the thumb, spaced evenly. */}
        <div className="pc-scale" aria-hidden="true">
          {marks.map((m, i) => (
            <span key={i} className={m === null ? 'minor' : m === '0' ? 'major zero' : 'major'}>
              {m !== null && <b>{m}</b>}
            </span>
          ))}
        </div>
        <input
          type="range"
          min={-range}
          max={range}
          step={range > 16 ? 0.1 : 0.05}
          value={pitch}
          disabled={!deck.canPitch}
          aria-label="Pitch"
          onChange={(e) => deck.setRate(1 + Number(e.target.value) / 100)}
          onDoubleClick={() => deck.setRate(1)}
          title={'Pitch ±' + range + '%: down speeds up (double-click: reset)'}
        />
      </div>
      <div className="pc-bend">
        <button
          disabled={!deck.canPitch}
          {...bend(-1)}
          title="Hold back: slows down while held, more and more (up to 8%)"
          aria-label="Hold back"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M7.5 2.5L4 6l3.5 3.5" />
          </svg>
        </button>
        <button disabled={!deck.canPitch} {...bend(1)} title="Push: speeds up while held, more and more (up to 8%)" aria-label="Push">
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4.5 2.5L8 6 4.5 9.5" />
          </svg>
        </button>
      </div>
      <button
        className={'pc-key' + (locked ? ' on' : '') + (shift ? ' warn' : '')}
        disabled={!deck.canKeyLock}
        aria-pressed={locked}
        onClick={() => deck.toggleKeyLock()}
        title={
          s.kind === 'youtube'
            ? 'YouTube always keeps the key when the tempo changes'
            : s.kind === 'spotify'
              ? "Spotify doesn't change the tempo"
              : locked
                ? 'Key lock on: the tempo changes without changing the key. Click to turn off'
                : 'Key lock off: the pitch changes the key too' +
                  (shift ? ' (now ' + (shift > 0 ? '+' : '') + shift + ' semitone)' : '') +
                  '. Click to turn on'
        }
      >
        KEY
      </button>
    </div>
  )
}
