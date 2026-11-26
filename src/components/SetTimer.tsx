import { useEffect, useRef, useState } from 'react'
import { formatSet, setTimer } from '../setTimer'
import { useStore } from '../store'

/** Re-renders every half second while a set is running (the countdown reads the wall clock). */
function useTick(on: boolean): void {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!on) return
    const timer = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(timer)
  }, [on])
}

/** How urgent the time left is: plenty · last 10 minutes · last 2 minutes · over. */
const stage = (left: number) => (left < 0 ? 'over' : left <= 120 ? 'last' : left <= 600 ? 'soon' : '')

/** Closes a popover on a click outside it or on Escape. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>): void {
  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key)
    }
  }, [open, close, ref])
}

/** The set's controls: length (presets and ±5), start / pause, reset, and the floating widget. */
function SetControls({ onFloat }: { onFloat?: () => void }) {
  const t = useStore(setTimer)
  const minutes = Math.round(t.length / 60)
  return (
    <div className="st-ctl">
      <div className="st-row">
        <span className="st-lab">Set length</span>
        <button onClick={() => setTimer.setLength(minutes - 5)} aria-label="5 minutes less">
          −5
        </button>
        <b className="st-len">{minutes} min</b>
        <button onClick={() => setTimer.setLength(minutes + 5)} aria-label="5 minutes more">
          +5
        </button>
      </div>
      <div className="st-presets">
        {setTimer.presets.map((m) => (
          <button key={m} className={minutes === m ? 'on' : ''} onClick={() => setTimer.setLength(m)}>
            {m < 60 ? m + "'" : Math.floor(m / 60) + 'h' + (m % 60 ? m % 60 : '')}
          </button>
        ))}
      </div>
      <div className="st-row">
        <button className={'st-go' + (setTimer.running ? ' on' : '')} onClick={() => setTimer.toggle()}>
          {setTimer.running ? 'PAUSE' : setTimer.active ? 'RESUME' : 'START'}
        </button>
        <button onClick={() => setTimer.reset()} disabled={!setTimer.active}>
          RESET
        </button>
        {onFloat && (
          <button onClick={onFloat} title={t.floating ? 'Put the countdown back on the top bar' : 'Show the countdown as a widget you can move'}>
            {t.floating ? 'DOCK' : 'WIDGET'}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Top bar: the wall clock, and next to it the set countdown once it has started (click either to set
 * the length, start, pause or float it as a widget).
 */
export function ClockAndSet() {
  const t = useStore(setTimer)
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(timer)
  }, [])
  useTick(setTimer.running)
  useDismiss(open, () => setOpen(false), box)
  const left = setTimer.left()
  const showChip = setTimer.active && !t.floating
  return (
    <div className="tb-set" ref={box}>
      <button
        className="tb-clock"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title="Time. Click: set countdown (how long you still have on stage)"
      >
        {now.getHours()}:{String(now.getMinutes()).padStart(2, '0')}
      </button>
      {showChip && (
        <button
          className={'tb-countdown ' + stage(left) + (setTimer.running ? '' : ' paused')}
          onClick={() => setOpen(!open)}
          title={left < 0 ? 'The set has run over by this much' : 'Time left in the set' + (setTimer.running ? '' : ' (paused)')}
        >
          <small>{left < 0 ? 'OVER' : 'SET'}</small>
          {formatSet(left)}
        </button>
      )}
      {open && (
        <div className="tb-pop st-pop" role="dialog" aria-label="Set countdown">
          <SetControls onFloat={() => setTimer.setFloating(!t.floating)} />
        </div>
      )}
    </div>
  )
}

/** The countdown as a widget over the app: big digits, drag it by its body, pause or dock it back. */
export function SetWidget() {
  const t = useStore(setTimer)
  useTick(setTimer.running)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  if (!t.floating) return null
  const left = setTimer.left()
  return (
    <div
      className={'set-widget ' + stage(left)}
      style={{ left: t.x, top: t.y }}
      role="timer"
      aria-label="Set countdown"
      onPointerDown={(e) => {
        if ((e.target as HTMLElement).closest('button')) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { dx: e.clientX - t.x, dy: e.clientY - t.y }
      }}
      onPointerMove={(e) => {
        if (!drag.current) return
        const w = e.currentTarget.offsetWidth
        const h = e.currentTarget.offsetHeight
        setTimer.move(
          Math.min(window.innerWidth - w, e.clientX - drag.current.dx),
          Math.min(window.innerHeight - h, e.clientY - drag.current.dy),
        )
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
    >
      <div className="sw-head">
        <span>{left < 0 ? 'SET OVER BY' : setTimer.active ? 'SET TIME LEFT' : 'SET'}</span>
        <button onClick={() => setTimer.setFloating(false)} aria-label="Dock the countdown on the top bar" title="Back to the top bar">
          ×
        </button>
      </div>
      <b className="sw-time">{formatSet(left)}</b>
      <div className="sw-row">
        <button className={setTimer.running ? 'on' : ''} onClick={() => setTimer.toggle()}>
          {setTimer.running ? 'PAUSE' : setTimer.active ? 'RESUME' : 'START'}
        </button>
        <button onClick={() => setTimer.reset()} disabled={!setTimer.active}>
          RESET
        </button>
      </div>
    </div>
  )
}
