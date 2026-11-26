import { useRef, useState } from 'react'
import { useStore } from '../store'
import { live } from '../live'

const time = (s: number) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0')

/**
 * A fader for one of the host's deck controls. While the hand is on it, the host's echo of the value
 * is ignored (it lags by a network round trip and would pull the slider back).
 */
function Slider({ label, action, value, center }: { label: string; action: string; value: number; center?: boolean }) {
  const [own, setOwn] = useState<number | null>(null)
  const frame = useRef(0)
  const next = useRef(0)
  return (
    <label className="gp-slider">
      <span>{label}</span>
      <input
        type="range"
        min={center ? -1 : 0}
        max={1}
        step={0.01}
        value={own ?? value}
        onPointerDown={() => setOwn(value)}
        onPointerUp={() => setOwn(null)}
        onBlur={() => setOwn(null)}
        onDoubleClick={() => center && live.act(action, 0)}
        onChange={(e) => {
          const v = Number(e.target.value)
          setOwn(v)
          next.current = v
          if (!frame.current)
            frame.current = requestAnimationFrame(() => {
              frame.current = 0
              live.act(action, next.current)
            })
        }}
      />
    </label>
  )
}

/** The guest's view of the host's set: the deck they steer, the other deck to read, and the host's library. */
export function GuestPanel() {
  const s = useStore(live)
  const [q, setQ] = useState('')
  const search = useRef(0)
  if (s.joined !== 'on') return null
  const name = s.hostDeck
  const d = s.snap?.[name]
  const other = s.snap?.[name === 'A' ? 'B' : 'A']
  const btn = (label: string, action: string, on?: boolean) => (
    <button className={'gp-key' + (on ? ' on' : '')} onClick={() => live.act(action)}>
      {label}
    </button>
  )
  return (
    <aside className={'guest-panel deck-' + name.toLowerCase()} aria-label={'Guest: deck ' + name}>
      <header>
        <b>DECK {name}</b>
        <span>{d?.title ? d.title + (d.artist ? ' · ' + d.artist : '') : 'No track: load one from the host library'}</span>
      </header>
      <div className="gp-info">
        <span>{d ? time(d.pos) + ' / ' + time(d.dur) : '–'}</span>
        <span>{d?.bpm ? d.bpm + ' BPM' : ''}</span>
        <span>{d ? (d.rate > 0 ? '+' : '') + d.rate + '%' : ''}</span>
      </div>
      <div className="gp-row">
        {btn('CUE', 'cue')}
        {btn(d?.playing ? 'PAUSE' : 'PLAY', 'play', d?.playing)}
        {btn('SYNC', 'sync', d?.sync)}
      </div>
      <div className="gp-row">
        {[1, 2, 3, 4].map((n) => btn(String(n), 'hotcue' + n, d?.hot[n - 1]))}
      </div>
      <div className="gp-row">
        {[1, 2, 4, 8].map((n) => btn('LOOP ' + n, 'loop' + n, d?.loop === n))}
      </div>
      <div className="gp-sliders">
        <Slider label="VOL" action="volume" value={d?.volume ?? 0} />
        <Slider label="PITCH" action="pitch" value={d?.pitch ?? 0} center />
        <Slider label="HIGH" action="high" value={d?.high ?? 0} center />
        <Slider label="MID" action="mid" value={d?.mid ?? 0} center />
        <Slider label="LOW" action="low" value={d?.low ?? 0} center />
        <Slider label="FILTER" action="filter" value={d?.filter ?? 0} center />
      </div>
      <p className="gp-other">
        Host · deck {name === 'A' ? 'B' : 'A'}: {other?.title || '—'} {other?.playing ? '▶' : ''} · crossfader{' '}
        {Math.round((s.snap?.mixer.crossfader ?? 0.5) * 100)}%
      </p>
      <input
        className="gp-search"
        value={q}
        placeholder="Search the host's library"
        aria-label="Search the host's library"
        onChange={(e) => {
          const v = e.target.value
          setQ(v)
          window.clearTimeout(search.current)
          search.current = window.setTimeout(() => live.send({ t: 'lib', q: v }), 200)
        }}
      />
      {s.libMsg && <p className="lv-err">{s.libMsg}</p>}
      <ul className="gp-lib">
        {s.lib.slice(0, 60).map((it) => (
          <li key={it.id}>
            <span>
              <b>{it.title}</b> {it.artist}
            </span>
            <em>{it.bpm ?? ''}</em>
            <button
              className="gp-key"
              disabled={!it.ready || !!d?.playing}
              title={d?.playing ? 'Pause your deck first' : it.ready ? 'Load on deck ' + name : 'Not ready on the host'}
              onClick={() => live.send({ t: 'load', d: name, id: it.id })}
            >
              LOAD
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
