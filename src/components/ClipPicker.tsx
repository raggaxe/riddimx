import { useEffect, useRef, useState } from 'react'
import { canSplit, openClipEntry, openClipFile, splitClipStems, type ClipTrack } from '../engine/cliptrack'
import { deckA, deckB, type ClipPart, type Deck } from '../engine/deck'
import { LYRICS_ON, lyrics } from '../engine/lyrics'
import { library } from '../library'
import { useStore } from '../store'

type From = 'A' | 'B' | 'lib' | 'file'
const FROM: [From, string, string][] = [
  ['A', 'Deck A', 'The track on deck A'],
  ['B', 'Deck B', 'The track on deck B'],
  ['lib', 'Library', 'Any file in your library or lists, without loading it on a deck'],
  ['file', 'File…', 'An audio file from this computer'],
]

const clock = (t: number) => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0')

const CLIP_PARTS: [ClipPart, string, string][] = [
  ['full', 'Full', 'The whole track, as it plays'],
  ['vocals', 'Vocals', 'The voice alone (AI stem)'],
  ['drums', 'Drums', 'The drums alone (AI stem)'],
  ['bass', 'Bass', 'The bass alone (AI stem)'],
  ['other', 'Music', 'Everything else: keys, guitar, horns… (AI stem)'],
]

/** A piece of a buffer, with short fades so it never clicks. */
export function cut(buffer: AudioBuffer, start: number, end: number): AudioBuffer {
  const rate = buffer.sampleRate
  const a = Math.max(0, Math.floor(start * rate))
  const b = Math.min(buffer.length, Math.floor(end * rate))
  const out = new AudioBuffer({ length: Math.max(1, b - a), numberOfChannels: buffer.numberOfChannels, sampleRate: rate })
  const fade = Math.min(Math.floor(rate * 0.012), Math.floor((b - a) / 2))
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c).slice(a, b)
    for (let i = 0; i < fade; i++) {
      d[i] *= i / fade
      d[d.length - 1 - i] *= i / fade
    }
    out.copyToChannel(d, c)
  }
  return out
}

/**
 * Pick a phrase out of a track — on a deck, in the library, or a file on the computer: the whole track drawn small, drag over it to choose
 * (or click a line of the lyrics), from the whole mix or one of its four AI stems once they are ready.
 * Gives back the piece of audio; the drop maker does the rest (effects, pad).
 */
export function ClipPicker({ onClip }: { onClip(buffer: AudioBuffer | null, name: string): void }) {
  const a = useStore(deckA)
  const b = useStore(deckB)
  const lyr = useStore(lyrics).lines
  const entries = useStore(library).entries
  const [from, setFrom] = useState<From>(() => (a.kind === 'local' || b.kind !== 'local' ? 'A' : 'B'))
  const onDeck = from === 'A' || from === 'B'
  const deckName: 'A' | 'B' = from === 'B' ? 'B' : 'A'
  const deck: Deck = deckName === 'A' ? deckA : deckB
  const s = deckName === 'A' ? a : b
  // A track opened just for the drop (library or file): its audio and, once split, its stems.
  const [track, setTrack] = useState<ClipTrack | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const [splitting, setSplitting] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const filePick = useRef<HTMLInputElement>(null)
  const [part, setPart] = useState<ClipPart>('vocals')
  const [sel, setSel] = useState<[number, number] | null>(null)
  const [zoom, setZoom] = useState(false) // close-up around the selection, to place its edges by hand
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const stemsReady = onDeck ? s.aiStems === 'ready' : !!track?.stems
  const source = onDeck
    ? deck.clipSource(stemsReady ? part : 'full')
    : track
      ? stemsReady && part !== 'full'
        ? track.stems![part]
        : track.buffer
      : null
  const title = onDeck ? s.title : (track?.title ?? '')
  const duration = source?.duration ?? 0
  const lines = LYRICS_ON && onDeck ? (lyr[s.ref ?? 'file:' + s.title] ?? []) : []

  const choose = (next: From) => {
    setFrom(next)
    setSel(null)
    if (next === 'file') filePick.current?.click()
  }
  const open = async (job: Promise<ClipTrack | null>, label: string) => {
    setOpening('Opening ' + label + '…')
    setSel(null)
    try {
      const t = await job
      setTrack(t)
      if (!t) setOpening("Couldn't open " + label + '.')
      else setOpening(null)
    } catch {
      setOpening("Couldn't read " + label + ': is it an audio file?')
    }
  }
  const split = async () => {
    if (!track) return
    setSplitting(0)
    try {
      const stems = await splitClipStems(track, (p) => setSplitting(p))
      if (stems) setTrack({ ...track, stems })
    } finally {
      setSplitting(null)
    }
  }
  // What the drawing shows: the whole track, or 2 s either side of the selection.
  // While dragging, the view holds still (it would otherwise follow the selection being drawn).
  const held = useRef<[number, number] | null>(null)
  const view: [number, number] =
    held.current ?? (zoom && sel ? [Math.max(0, sel[0] - 2), Math.min(duration, sel[1] + 2)] : [0, duration])
  const span = Math.max(0.001, view[1] - view[0])

  // The track, small: what is selected is bright, the rest dim.
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    if (!source) return
    const d = source.getChannelData(0)
    const rate = source.sampleRate
    const first = Math.floor(view[0] * rate)
    const step = Math.max(1, Math.floor((span * rate) / w))
    for (let x = 0; x < w; x++) {
      let peak = 0
      const from = first + x * step
      for (let i = from; i < from + step && i < d.length; i += step > 64 ? 4 : 1) peak = Math.max(peak, Math.abs(d[i]))
      const t = view[0] + (x / w) * span
      const inside = sel && t >= sel[0] && t <= sel[1]
      g.fillStyle = inside ? '#f5a524' : 'rgba(217, 211, 199, 0.35)'
      const bar = Math.max(1, Math.min(1, peak * 1.4) * h * 0.95)
      g.fillRect(x, (h - bar) / 2, 1, bar)
    }
    if (sel) {
      g.fillStyle = 'rgba(245, 165, 36, 0.12)'
      g.fillRect(((sel[0] - view[0]) / span) * w, 0, ((sel[1] - sel[0]) / span) * w, h)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sel, duration, zoom])

  // A new selection, or a new source, gives a new piece.
  useEffect(() => {
    if (!source || !sel || sel[1] - sel[0] < 0.15) return onClip(null, '')
    const timer = window.setTimeout(() => onClip(cut(source, sel[0], sel[1]), title), 150)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, sel])

  const timeAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(duration, view[0] + ((e.clientX - r.left) / r.width) * span))
  }

  const fromDeck = () => {
    const at = deck.getPosition()
    setSel([at, Math.min(duration, at + 2.5)])
    setZoom(true)
  }

  const local = entries.filter((e) => e.kind === 'local' && (e.file || e.path))
  const found = query.trim()
    ? local.filter((e) => (e.title + ' ' + e.artist + ' ' + (e.list ?? '')).toLowerCase().includes(query.trim().toLowerCase()))
    : local

  const top = (
    <>
      <div className="dr-seg dr-clip-from" role="group" aria-label="Take the track from">
        {FROM.map(([id, label, hint]) => (
          <button
            key={id}
            className={from === id ? 'now' : ''}
            aria-pressed={from === id}
            title={hint}
            onClick={() => choose(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <input
        ref={filePick}
        type="file"
        accept="audio/*,.mp3,.wav,.aif,.aiff,.m4a,.flac,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void open(openClipFile(f), '"' + f.name + '"')
        }}
      />
    </>
  )

  if (!source) {
    return (
      <div className="dr-clip">
        {top}
        {onDeck ? (
          <p className="dr-note">Deck {deckName} has no file on it. Load one, or take the track from the Library or a File.</p>
        ) : from === 'file' ? (
          <p className="dr-note">
            {opening ?? 'Choose an audio file from this computer.'}{' '}
            {!opening && (
              <button className="link" onClick={() => filePick.current?.click()}>
                Choose a file…
              </button>
            )}
          </p>
        ) : (
          <div className="dr-clip-lib">
            <input
              value={query}
              placeholder="Search your library and lists…"
              aria-label="Search the library"
              onChange={(e) => setQuery(e.target.value)}
            />
            {opening && <p className="dr-note">{opening}</p>}
            <ul>
              {found.slice(0, 60).map((e) => (
                <li key={e.id}>
                  <button onClick={() => void open(openClipEntry(e), '"' + e.title + '"')} title={'Cut a drop from ' + e.title}>
                    <span>{e.title}</span>
                    <small>{[e.artist, e.list].filter(Boolean).join(' · ')}</small>
                  </button>
                </li>
              ))}
              {!found.length && <li className="dr-note">{local.length ? 'Nothing matches.' : 'No files in the library yet.'}</li>}
            </ul>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="dr-clip">
      {top}
      <div className="dr-clip-top">
        <span className="dr-clip-title" title={title}>
          {title}
        </span>
        {!onDeck && (
          <button className="link" onClick={() => (from === 'file' ? filePick.current?.click() : (setTrack(null), setSel(null)))}>
            {from === 'file' ? 'Other file…' : 'Other track…'}
          </button>
        )}
      </div>
      {/* Which part of the track the phrase is cut from: the whole mix or one of the four AI stems. */}
      <div className="dr-seg dr-clip-parts" role="group" aria-label="Cut from">
        {CLIP_PARTS.map(([id, label, hint]) => {
          const off = id !== 'full' && !stemsReady
          return (
            <button
              key={id}
              className={(stemsReady ? part : 'full') === id ? 'now' : ''}
              aria-pressed={(stemsReady ? part : 'full') === id}
              disabled={off}
              title={
                off
                  ? onDeck
                    ? s.aiStems === 'working'
                      ? 'Splitting the stems… ' + Math.round(s.aiProgress * 100) + '%'
                      : 'The stems are ready once the deck has split this track (desktop app, files)'
                    : 'Split the stems first (button below)'
                  : hint
              }
              onClick={() => (setPart(id), setSel(null))}
            >
              {label}
            </button>
          )
        })}
      </div>
      {!onDeck && !stemsReady && (
        <div className="dr-clip-split">
          {canSplit() ? (
            <button
              onClick={() => void split()}
              disabled={splitting !== null}
              title="Split this track into vocals, drums, bass and music (about half a minute); kept for next time"
            >
              {splitting !== null ? 'Splitting… ' + Math.round(splitting * 100) + '%' : 'Split stems'}
            </button>
          ) : (
            <span className="dr-note">Stems are split in the desktop app.</span>
          )}
        </div>
      )}
      <canvas
        ref={canvas}
        className="dr-clip-wave"
        title="Drag over the phrase you want"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          held.current = view
          const t = timeAt(e)
          drag.current = t
          setSel([t, t])
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return
          const t = timeAt(e)
          setSel([Math.min(drag.current, t), Math.max(drag.current, t)])
        }}
        onPointerUp={() => {
          drag.current = null
          held.current = null
        }}
      />
      <div className="dr-clip-sel">
        <span>
          {sel
            ? clock(sel[0]) + ' – ' + clock(sel[1]) + ' · ' + (sel[1] - sel[0]).toFixed(1) + ' s'
            : 'Drag on the waveform to pick the phrase'}
        </span>
        {sel && (
          <>
            <button onClick={() => setSel([Math.max(0, sel[0] - 0.1), sel[1]])} title="Start 0.1 s earlier">
              ◂
            </button>
            <button onClick={() => setSel([Math.min(sel[1] - 0.2, sel[0] + 0.1), sel[1]])} title="Start 0.1 s later">
              ▸
            </button>
            <i />
            <button onClick={() => setSel([sel[0], Math.max(sel[0] + 0.2, sel[1] - 0.1)])} title="End 0.1 s earlier">
              ◂
            </button>
            <button onClick={() => setSel([sel[0], Math.min(duration, sel[1] + 0.1)])} title="End 0.1 s later">
              ▸
            </button>
          </>
        )}
        <button
          className={'dr-clip-zoom' + (zoom ? ' on' : '')}
          disabled={!sel}
          onClick={() => setZoom(!zoom)}
          title={zoom ? 'Show the whole track' : 'Zoom in around the phrase to set its start and end'}
        >
          {zoom ? 'Whole' : 'Zoom'}
        </button>
        {onDeck && (
          <button className="dr-clip-deck" onClick={fromDeck} title="Start where the deck is now (2.5 s)">
            From the deck
          </button>
        )}
      </div>
      {lines.length > 0 && (
        <div className="dr-chips dr-lines" aria-label="Lyric lines">
          {lines.map((l, i) => (
            <button
              key={i}
              className={sel && Math.abs(sel[0] - l.time) < 0.05 ? 'now' : ''}
              onClick={() => {
                setSel([l.time, Math.min(duration, lines[i + 1]?.time ?? l.time + 4)])
                setZoom(true)
              }}
              title={'Use this phrase: ' + l.text}
            >
              {l.text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
