import { useEffect, useRef } from 'react'
import { deckA, deckB } from '../engine/deck'
import { mixer } from '../engine/mixer'
import { MOVES, moves, route, type Direction, type Move } from '../engine/moves'
import { useStore } from '../store'

const nextDir: Record<Direction, Direction> = { auto: 'AB', AB: 'BA', BA: 'auto' }

/** Which way the transitions go: A → B, B → A, or AUTO (out goes the deck heard). */
export function TransitionRoute() {
  const mv = useStore(moves)
  useStore(deckA)
  useStore(deckB)
  useStore(mixer)
  // While a move runs, the arrow shows that move's decks; otherwise who would go now.
  const way = mv.from ? route(mv.from === 'A' ? 'AB' : 'BA') : route(mv.direction)
  return (
    <button
      className={'mx-tr-route' + (mv.direction === 'auto' ? ' auto' : '')}
      onClick={() => moves.settings({ direction: nextDir[mv.direction] })}
      disabled={!!mv.running}
      title={
        mv.direction === 'auto'
          ? 'Automatic transitions: the deck on air goes out, the other comes in. Click to fix A → B'
          : 'Fixed transitions. Click to ' + (mv.direction === 'AB' ? 'B → A' : 'go back to automatic')
      }
    >
      <b className={way ? way.from.name.toLowerCase() : ''}>{way?.from.name ?? '—'}</b>
      <svg viewBox="0 0 12 8" width="10" height="7" aria-hidden="true">
        <path d="M1 4h9M7 1l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <b className={way ? way.to.name.toLowerCase() : ''}>{way?.to.name ?? '—'}</b>
      <span>{mv.direction === 'auto' ? 'AUTO' : 'FIXED'}</span>
    </button>
  )
}

/** How long the long transitions last, and whether they start on the next beat or the next bar. */
export function TransitionTiming() {
  const mv = useStore(moves)
  return (
    <>
      <select
        className="mx-tr-beats"
        value={mv.beats}
        aria-label="Length of the long transitions"
        title="Length of the bass swap and the sweep, in beats"
        onChange={(e) => moves.settings({ beats: Number(e.target.value) as 4 | 8 | 16 })}
      >
        {[4, 8, 16].map((n) => (
          <option key={n} value={n}>
            {n} beats
          </option>
        ))}
      </select>
      <button
        className={'mx-tr-quant' + (mv.quant === 'bar' ? ' on' : '')}
        onClick={() => moves.settings({ quant: mv.quant === 'bar' ? 'beat' : 'bar' })}
        title={
          mv.quant === 'bar'
            ? 'Transitions start on the next bar (on the one). Click to start on the next beat'
            : 'Transitions start on the next beat. Click to wait for the bar'
        }
      >
        {mv.quant === 'bar' ? 'BAR' : 'BEAT'}
      </button>
    </>
  )
}

/** The six beat-synced transitions; the running one fills its button, a click on it cancels. */
export function TransitionMoves() {
  const mv = useStore(moves)
  useStore(deckA)
  useStore(deckB)
  useStore(mixer)
  const way = mv.from ? route(mv.from === 'A' ? 'AB' : 'BA') : route(mv.direction)
  const bar = useRef<HTMLDivElement>(null)
  // Progress of the running move, drawn every frame without re-rendering.
  useEffect(() => {
    if (!mv.running) return
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const t = Math.min(1, Math.max(0, (performance.now() - mv.startedAt) / (mv.length * 1000)))
      bar.current?.querySelector<HTMLElement>('button.on')?.style.setProperty('--p', String(t))
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mv.running, mv.startedAt, mv.length])
  return (
    <div className="mx-tr-moves" ref={bar} role="group" aria-label="Transitions">
      {(Object.keys(MOVES) as Move[]).map((m) => (
        <button
          key={m}
          className={(mv.running === m ? 'on' : '') + (mv.running === m && mv.waiting ? ' armed' : '')}
          disabled={!way || (!!mv.running && mv.running !== m)}
          onClick={() => moves.run(m)}
          title={mv.running === m ? 'Click to cancel and restore everything' : MOVES[m].hint}
        >
          {MOVES[m].label}
          <i aria-hidden="true" />
        </button>
      ))}
    </div>
  )
}
