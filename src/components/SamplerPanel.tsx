import { useEffect, useRef, useState } from 'react'
import { sampler } from '../engine/sampler'
import { SFX } from '../engine/soundsystem'
import { DropsPanel } from './DropsPanel'
import { useStore } from '../store'
import { ui } from '../ui'

type View = 'pads' | 'drops'
const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'pads', label: 'Pads', hint: 'Oito pads de jingles e efeitos' },
  { id: 'drops', label: 'Drops', hint: 'Criar drops e jingles com voz, para os pads' },
]
const LS_VIEW = 'vx_sampler_view'

/** 2.4 → "2.4s", 75 → "1:15" */
const secs = (t: number) =>
  t < 60 ? t.toFixed(t < 10 ? 1 : 0) + 's' : Math.floor(t / 60) + ':' + String(Math.round(t % 60)).padStart(2, '0')

/** Typing in a field must not fire pads. */
const typing = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/**
 * Eight pads for jingles and effects: click an empty pad (or drop a file on it) to load, click to play.
 * Drops (jingles made with a voice) are made on the page beside it.
 */
export function SamplerPanel() {
  const s = useStore(sampler)
  const picker = useRef<HTMLInputElement>(null)
  const target = useRef(0)
  const [view, setView] = useState<View>(() => {
    try {
      const saved = localStorage.getItem(LS_VIEW) as View | null
      return VIEWS.some((v) => v.id === saved) ? saved! : 'pads'
    } catch {
      return 'pads'
    }
  })
  const [over, setOver] = useState<number | null>(null) // pad a sound is being dragged over
  // Bumped on every new play, so the drain bar restarts when a pad is retriggered.
  const [plays, setPlays] = useState<number[]>(() => s.pads.map(() => 0))
  const was = useRef(s.pads.map((p) => p.playing))
  useEffect(() => {
    const started = s.pads.map((p, i) => p.playing && !was.current[i])
    was.current = s.pads.map((p) => p.playing)
    if (started.some(Boolean)) setPlays((n) => n.map((k, i) => (started[i] ? k + 1 : k)))
  }, [s.pads])

  const choose = (i: number) => {
    target.current = i
    picker.current?.click()
  }

  // While the pads are on screen, keys 1 to 8 fire them and Esc stops them all.
  useEffect(() => {
    if (view !== 'pads') return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || ui.get().settings) return
      const n = Number(e.key)
      if (n >= 1 && n <= s.pads.length) {
        e.preventDefault()
        if (sampler.get().pads[n - 1].name) sampler.trigger(n - 1)
      } else if (e.key === 'Escape' && sampler.get().pads.some((p) => p.playing)) sampler.stopAll()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [view, s.pads.length])

  const open = (next: View) => {
    setView(next)
    try {
      localStorage.setItem(LS_VIEW, next)
    } catch {
      /* not remembered */
    }
  }

  return (
    <div className="sampler sp">
      <nav className="side-nav" aria-label="Secções do sampler">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            className={'side-item' + (view === v.id ? ' active' : '')}
            aria-pressed={view === v.id}
            title={v.hint}
            onClick={() => open(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>
      {view === 'drops' && <DropsPanel />}
      {view === 'pads' && (
        <div className="sp-pads">
          <div className="sampler-pads">
            {s.pads.map((pad, i) => (
              <div
                key={i}
                className={'sample' + (pad.name ? ' loaded' : '') + (pad.playing ? ' playing' : '') + (over === i ? ' over' : '')}
                onDragOver={(e) => {
                  e.preventDefault()
                  if (over !== i) setOver(i)
                }}
                onDragLeave={() => setOver((o) => (o === i ? null : o))}
                onDrop={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setOver(null)
                  const id = e.dataTransfer.getData('application/x-vx-sfx')
                  if (id) void sampler.assign(i, id)
                  else if (e.dataTransfer.files[0]) void sampler.load(i, e.dataTransfer.files[0])
                }}
              >
                <button
                  className="sample-hit"
                  onClick={() => {
                    if (pad.name) sampler.trigger(i)
                    else choose(i)
                  }}
                  aria-label={pad.name ? 'Pad ' + (i + 1) + ': ' + pad.name : 'Pad ' + (i + 1) + ' vazio: escolher arquivo'}
                  title={
                    pad.name
                      ? (pad.playing ? 'Parar' : 'Tocar') + ' (tecla ' + (i + 1) + '). Solte outro som aqui para trocar'
                      : 'Escolher um arquivo de áudio, ou soltar aqui um efeito ou arquivo'
                  }
                >
                  {/* How much of the sample is left: drains over exactly its length. */}
                  {pad.playing && <i key={plays[i]} className="sample-bar" style={{ animationDuration: pad.duration + 's' }} />}
                  <b>{i + 1}</b>
                  {pad.name && <em>{secs(pad.duration)}</em>}
                  <span>{pad.name ?? '+ som'}</span>
                </button>
                {pad.name && (
                  <button className="sample-clear" onClick={() => sampler.clear(i)} aria-label={'Esvaziar pad ' + (i + 1)} title="Esvaziar">
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="sp-bank">
            <div className="sp-bank-head">
              <h5 title="Clique: ouvir. Arraste para um pad, ou solte lá um arquivo seu. Os pads ficam salvos e são mapeáveis na controladora.">
                Efeitos
              </h5>
              <label className="sampler-vol">
                <span>Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={s.volume}
                  onChange={(e) => sampler.setVolume(Number(e.target.value))}
                />
                <output>{Math.round(s.volume * 100)}</output>
              </label>
              <button
                className="btn small sp-stop"
                disabled={!s.pads.some((p) => p.playing)}
                onClick={() => sampler.stopAll()}
                title="Parar todos os pads (Esc)"
              >
                Parar
              </button>
            </div>
            <div className="sfx-bank">
              {SFX.map((fx) => {
                const used = s.pads.findIndex((p) => p.name === fx.label)
                return (
                  <button
                    key={fx.id}
                    className={'sfx' + (used >= 0 ? ' used' : '')}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-vx-sfx', fx.id)
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    onClick={() => void sampler.preview(fx.id)}
                    title={
                      (used >= 0 ? 'No pad ' + (used + 1) + '. ' : '') +
                      'Clique: ouvir (no headphone, se estiver ligado). Arrastar para um pad: pôr lá'
                    }
                  >
                    {fx.label}
                    {used >= 0 && <i>{used + 1}</i>}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
      <input
        ref={picker}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void sampler.load(target.current, file)
          e.target.value = ''
        }}
      />
    </div>
  )
}
