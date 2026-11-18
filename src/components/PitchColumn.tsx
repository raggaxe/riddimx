import { useEffect, useRef, useState } from 'react'
import type { Deck } from '../engine/deck'
import { useStore } from '../store'
import { Scale } from './Meter'

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
    className: 'btn small' + (bending === dir ? ' held' : ''),
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

  return (
    <aside className={'pitch-col pitch-' + deck.name.toLowerCase()} aria-label={'Pitch do deck ' + deck.name}>
    <div className="dk-pitch">
      <div className="pitch-top">
        <button
          className={'pitch-read' + (Math.abs(pitch) < 0.05 ? ' zero' : '') + (s.syncOn ? ' synced' : '')}
          disabled={!deck.canPitch || Math.abs(pitch) < 0.05}
          onClick={() => deck.setRate(1)}
          title={s.syncOn ? 'Tempo seguido pelo SYNC' : 'Pitch em %. Clique para voltar a 0'}
          aria-label={'Pitch ' + pitch.toFixed(1) + '%. Voltar a zero'}
        >
          <output>
            {pitch >= 0 ? '+' : ''}
            {pitch.toFixed(1)}
            <small>%</small>
          </output>
          {s.syncOn && <em>SYNC</em>}
        </button>
        <button
          className="pitch-range"
          onClick={nextRange}
          disabled={!deck.canPitch}
          title="Alcance do pitch: clique para mudar (8, 16 ou 50%)"
        >
          ±{range}
        </button>
      </div>
      <div className="pitch-row">
        <Scale marks={marksFor(range)} className={deck.name === 'B' ? 'right' : ''} />
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
          title={'Pitch ±' + range + '%: para baixo acelera (duplo clique: zerar)'}
        />
        <Scale marks={marksFor(range)} className={deck.name === 'B' ? '' : 'right'} bare />
      </div>
      <div className="pitch-foot">
        <button
          className={'pad keylock' + (locked ? ' set' : '') + (shift ? ' warn' : '')}
          disabled={!deck.canKeyLock}
          aria-pressed={locked}
          onClick={() => deck.toggleKeyLock()}
          title={
            s.kind === 'youtube'
              ? 'YouTube mantém sempre o tom ao mudar o tempo'
              : s.kind === 'spotify'
                ? 'Spotify não muda o tempo'
                : locked
                  ? 'Key lock ligado: o tempo muda sem mudar o tom. Clique para desligar'
                  : 'Key lock desligado: o pitch muda também o tom' +
                    (shift ? ' (agora ' + (shift > 0 ? '+' : '') + shift + ' meio-tom)' : '') +
                    '. Clique para ligar'
          }
        >
          <svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">
            <rect x="2.5" y="5.5" width="7" height="5" rx="1" fill="currentColor" />
            <path
              d={locked ? 'M4 5.5V4a2 2 0 014 0v1.5' : 'M4 5.5V4a2 2 0 013.9-.6'}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinecap="round"
            />
          </svg>
          KEY
        </button>
        <div className="dk-bend">
          <button
            disabled={!deck.canPitch}
            {...bend(-1)}
            title="Travar: atrasa enquanto segura, cada vez mais (até 8%)"
            aria-label="Travar"
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M7.5 2.5L4 6l3.5 3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button
            disabled={!deck.canPitch}
            {...bend(1)}
            title="Empurrar: adianta enquanto segura, cada vez mais (até 8%)"
            aria-label="Empurrar"
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M4.5 2.5L8 6 4.5 9.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
    </aside>
  )
}
