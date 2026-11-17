import { useEffect, useRef, useState } from 'react'
import { deckA, deckB, type Deck } from '../engine/deck'
import { lyrics } from '../engine/lyrics'
import { useStore } from '../store'

const clock = (t: number) => Math.floor(t / 60) + ':' + (t % 60).toFixed(1).padStart(4, '0')

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
 * Pick a phrase out of a track on a deck: the whole track drawn small, drag over it to choose
 * (or click a line of the lyrics), with the voice alone when the AI stems are ready.
 * Gives back the piece of audio; the drop maker does the rest (effects, pad).
 */
export function ClipPicker({ onClip }: { onClip(buffer: AudioBuffer | null, name: string): void }) {
  const a = useStore(deckA)
  const b = useStore(deckB)
  const lyr = useStore(lyrics).lines
  const [deckName, setDeckName] = useState<'A' | 'B'>(() => (a.kind === 'local' || b.kind !== 'local' ? 'A' : 'B'))
  const deck: Deck = deckName === 'A' ? deckA : deckB
  const s = deckName === 'A' ? a : b
  const [voiceOnly, setVoiceOnly] = useState(true)
  const [sel, setSel] = useState<[number, number] | null>(null)
  const [zoom, setZoom] = useState(false) // close-up around the selection, to place its edges by hand
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<number | null>(null)
  const stemsReady = s.aiStems === 'ready'
  const source = deck.clipSource(voiceOnly && stemsReady)
  const duration = source?.duration ?? 0
  const lines = lyr[s.ref ?? 'file:' + s.title] ?? []
  // What the drawing shows: the whole track, or 2 s either side of the selection.
  // While dragging, the view holds still (it would otherwise follow the selection being drawn).
  const held = useRef<[number, number] | null>(null)
  const view: [number, number] = held.current ?? (zoom && sel ? [Math.max(0, sel[0] - 2), Math.min(duration, sel[1] + 2)] : [0, duration])
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
    const timer = window.setTimeout(() => onClip(cut(source, sel[0], sel[1]), s.title), 150)
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

  if (!source) {
    return (
      <p className="dr-note">
        Carrega uma música (ficheiro) no deck {deckName} para recortar uma frase dela.
        {(a.kind === 'local' || b.kind === 'local') && (
          <button className="link" onClick={() => setDeckName(deckName === 'A' ? 'B' : 'A')}>
            Usar o deck {deckName === 'A' ? 'B' : 'A'}
          </button>
        )}
      </p>
    )
  }

  return (
    <div className="dr-clip">
      <div className="dr-clip-top">
        <div className="dr-seg" role="group" aria-label="Deck">
          {(['A', 'B'] as const).map((n) => (
            <button
              key={n}
              className={deckName === n ? 'now' : ''}
              aria-pressed={deckName === n}
              onClick={() => (setDeckName(n), setSel(null))}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="dr-clip-title" title={s.title}>
          {s.title}
        </span>
        <label
          className="dr-listen"
          title={stemsReady ? 'Só a voz, separada pela IA' : 'A voz separada fica pronta quando os stems IA do deck acabarem'}
        >
          <input
            type="checkbox"
            checked={voiceOnly && stemsReady}
            disabled={!stemsReady}
            onChange={(e) => setVoiceOnly(e.target.checked)}
          />
          Só a voz
        </label>
      </div>
      <canvas
        ref={canvas}
        className="dr-clip-wave"
        title="Arrasta por cima da frase que queres"
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
            : 'Arrasta na onda para escolher a frase'}
        </span>
        {sel && (
          <>
            <button onClick={() => setSel([Math.max(0, sel[0] - 0.1), sel[1]])} title="Começar 0,1 s antes">
              ◂
            </button>
            <button onClick={() => setSel([Math.min(sel[1] - 0.2, sel[0] + 0.1), sel[1]])} title="Começar 0,1 s depois">
              ▸
            </button>
            <i />
            <button onClick={() => setSel([sel[0], Math.max(sel[0] + 0.2, sel[1] - 0.1)])} title="Acabar 0,1 s antes">
              ◂
            </button>
            <button onClick={() => setSel([sel[0], Math.min(duration, sel[1] + 0.1)])} title="Acabar 0,1 s depois">
              ▸
            </button>
          </>
        )}
        <button
          className={'dr-clip-zoom' + (zoom ? ' on' : '')}
          disabled={!sel}
          onClick={() => setZoom(!zoom)}
          title={zoom ? 'Ver a música toda' : 'Aproximar à volta da frase, para acertar o início e o fim'}
        >
          {zoom ? 'Toda' : 'Zoom'}
        </button>
        <button className="dr-clip-deck" onClick={fromDeck} title="Começa onde o deck está agora (2,5 s)">
          Do deck
        </button>
      </div>
      {lines.length > 0 && (
        <div className="dr-chips dr-lines" aria-label="Frases da letra">
          {lines.map((l, i) => (
            <button
              key={i}
              className={sel && Math.abs(sel[0] - l.time) < 0.05 ? 'now' : ''}
              onClick={() => {
                setSel([l.time, Math.min(duration, lines[i + 1]?.time ?? l.time + 4)])
                setZoom(true)
              }}
              title={'Escolher esta frase: ' + l.text}
            >
              {l.text}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
