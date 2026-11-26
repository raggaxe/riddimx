import { useEffect, useMemo, useRef, useState } from 'react'
import { decks } from '../engine/deck'
import { liveDeck } from '../engine/outboard'
import { library } from '../library'
import { linePlayed, notes, playedTitles } from '../notes'
import { formatSet, setTimer } from '../setTimer'
import { useStore } from '../store'

/** "Artist – Title · 120 BPM · 8A" for a deck's track. */
function trackLine(i: number): string | null {
  const s = decks[i].get()
  if (!s.title) return null
  const bpm = s.bpm ? ' · ' + Math.round(s.bpm * s.rate) + ' BPM' : ''
  const key = s.key ? ' · ' + s.key : ''
  return (s.artist ? s.artist + ' – ' : '') + s.title + bpm + key
}

/**
 * Notes on the top bar: a pad for the set plan and reminders. WRITE is the text; SET LIST shows the
 * "- " lines with the ones already played ticked. Buttons drop in the track on air or a time stamp.
 */
export function NotesButton() {
  const n = useStore(notes)
  useStore(library)
  useStore(decks[0])
  useStore(decks[1])
  const [view, setView] = useState<'write' | 'list'>('write')
  const box = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!n.open) return
    const down = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) notes.toggle(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && notes.toggle(false)
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('pointerdown', down)
      window.removeEventListener('keydown', key)
    }
  }, [n.open])

  const lines = n.text.split('\n')
  const played = useMemo(() => playedTitles(), [n.open, n.text, view]) // eslint-disable-line react-hooks/exhaustive-deps
  const items = lines.filter((l) => /^\s*-\s+\S/.test(l))
  const done = items.filter((l) => linePlayed(l, played)).length

  /** Puts text at the cursor (on its own line), keeps the cursor after it. */
  const insert = (text: string) => {
    const el = area.current
    const at = el ? el.selectionStart : n.text.length
    const before = n.text.slice(0, at)
    const after = n.text.slice(at)
    const lead = before && !before.endsWith('\n') ? '\n' : ''
    const next = before + lead + text + (after.startsWith('\n') || !after ? '' : '\n') + after
    notes.setText(next)
    setView('write')
    requestAnimationFrame(() => {
      if (!area.current) return
      const pos = (before + lead + text).length
      area.current.focus()
      area.current.setSelectionRange(pos, pos)
    })
  }

  const live = liveDeck()
  const onAir = live ? trackLine(decks.indexOf(live)) : null
  const stamp = () => {
    const clock = new Date()
    const time = clock.getHours() + ':' + String(clock.getMinutes()).padStart(2, '0')
    return '[' + (setTimer.active ? 'set ' + formatSet(setTimer.elapsed()) : time) + '] '
  }

  return (
    <div className="tb-notes" ref={box}>
      <button
        className={'tb-notes-btn' + (n.open ? ' on' : '')}
        onClick={() => notes.toggle()}
        aria-expanded={n.open}
        title="Notes: your set plan and reminders. Lines starting with “- ” form the set list and tick themselves when played"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path d="M3.5 2.5h9v11h-9z M5.5 5.5h5 M5.5 8h5 M5.5 10.5h3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </svg>
        NOTES
        {items.length > 0 && <small>{done + '/' + items.length}</small>}
      </button>
      {n.open && (
        <div className="tb-pop nt-pop" role="dialog" aria-label="Set notes">
          <div className="nt-bar">
            <div className="nt-tabs" role="tablist">
              <button role="tab" aria-selected={view === 'write'} className={view === 'write' ? 'on' : ''} onClick={() => setView('write')}>
                WRITE
              </button>
              <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>
                SET LIST {items.length > 0 && done + '/' + items.length}
              </button>
            </div>
            <button onClick={() => onAir && insert('- ' + onAir)} disabled={!onAir} title={onAir ? 'Add the track on air: ' + onAir : 'No track on air'}>
              + ON AIR
            </button>
            <button onClick={() => insert(stamp())} title="Add a time stamp (set time if the countdown runs, else the clock)">
              + TIME
            </button>
          </div>
          {view === 'write' ? (
            <textarea
              ref={area}
              className="nt-text"
              value={n.text}
              onChange={(e) => notes.setText(e.target.value)}
              placeholder={'Plan your set, one track per line:\n- Chronixx – Here Comes Trouble\n- Sizzla – Solid As A Rock\n\nOr anything: shout-outs, the next DJ at 23:00…'}
              spellCheck={false}
              autoFocus
            />
          ) : (
            <ol className="nt-list">
              {items.length === 0 && <li className="nt-empty">No set list yet: write lines starting with “- ” in WRITE.</li>}
              {items.map((l, i) => {
                const ok = linePlayed(l, played)
                return (
                  <li key={i} className={ok ? 'played' : ''}>
                    <i aria-hidden="true">{ok ? '✓' : i + 1}</i>
                    <span>{l.replace(/^\s*-\s*/, '')}</span>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
