import { useEffect, useRef } from 'react'
import { mixer } from '../engine/mixer'
import { deckA, deckB } from '../engine/deck'
import { autoDub, DUB_LEVELS, type DubLevel } from '../engine/autodub'
import { DIVISIONS, liveDeck, outboard, type Division } from '../engine/outboard'
import { useStore } from '../store'
import { ui } from '../ui'
import { Knob } from './Knob'
import { DubBoxStrip } from './MixerView'
import { MixSection } from './MasterStrip'

const pct = (v: number) => Math.round(v * 100) + '%'

/**
 * Tape echo with a spring tank (its own tab at the bottom): hold THROW to send a deck in, the time
 * follows the music (or TAP / TEMPO by hand), the repeats, the tape, the spring and a kick on it.
 */
export function EchoUnit() {
  const o = useStore(outboard)
  useStore(deckA)
  useStore(deckB)
  const hold = (deck: 'A' | 'B') => ({
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      outboard.throw(deck, true)
    },
    onPointerUp: () => outboard.throw(deck, false),
    onPointerCancel: () => outboard.throw(deck, false),
  })
  const manual = o.timeMode === 'manual'
  return (
    <div className="echo-desk">
      <MixSection title="Atirar" className="echo-throw">
        <div className="echo-throws">
          <button className={'ru-throw a' + (o.throwing.A ? ' on' : '')} {...hold('A')} title="Manter premido: atira o deck A para o eco">
            THROW A
          </button>
          <button className={'ru-throw b' + (o.throwing.B ? ' on' : '')} {...hold('B')} title="Manter premido: atira o deck B para o eco">
            THROW B
          </button>
        </div>
        <Knob label="ENVIO A" value={o.send.A} min={0} max={1} reset={0} format={pct} onChange={(v) => outboard.setSend('A', v)} />
        <Knob label="ENVIO B" value={o.send.B} min={0} max={1} reset={0} format={pct} onChange={(v) => outboard.setSend('B', v)} />
      </MixSection>
      <MixSection title={manual ? 'Tempo · à mão' : 'Tempo · segue a música'} className="echo-time">
        <select
          className="ru-select"
          value={o.division}
          aria-label="Tempo do eco"
          title="Tempo do eco pela batida da música"
          onChange={(e) => {
            outboard.update({ division: e.target.value as Division })
            outboard.syncTime()
          }}
        >
          {DIVISIONS.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id}
            </option>
          ))}
        </select>
        <button
          className={'ru-tap' + (manual ? ' on' : '')}
          onClick={() => outboard.tap()}
          onDoubleClick={() => outboard.syncTime()}
          title="Bate 2 ou mais vezes no tempo que queres. Duplo clique: volta a seguir a música"
        >
          TAP · {Math.round(outboard.echoTime * 1000)} ms
        </button>
        <Knob
          label="TEMPO"
          value={outboard.echoTime}
          min={0.05}
          max={2}
          reset={0.375}
          format={(v) => Math.round(v * 1000) + ' ms'}
          onChange={(v) => outboard.setManualTime(v)}
        />
      </MixSection>
      <MixSection title="Fita" className="echo-tape">
        <Knob
          label="REPETIR"
          value={o.feedback}
          min={0}
          max={1.1}
          reset={0.55}
          format={(v) => (v > 1 ? 'SOLTO ' : '') + Math.round(v * 100) + '%'}
          onChange={(v) => outboard.update({ feedback: v })}
        />
        <Knob
          label="TOM"
          value={o.tone}
          min={0}
          max={1}
          reset={0.45}
          format={(v) => (v < 0.35 ? 'escuro' : v > 0.7 ? 'claro' : 'fita')}
          onChange={(v) => outboard.update({ tone: v })}
        />
        <Knob
          label="DESGASTE"
          value={o.wobble}
          min={0}
          max={1}
          reset={0.35}
          format={pct}
          onChange={(v) => outboard.update({ wobble: v })}
        />
      </MixSection>
      <MixSection title="Mola" className="echo-spring">
        <Knob label="MOLA" value={o.spring} min={0} max={1} reset={0.4} format={pct} onChange={(v) => outboard.update({ spring: v })} />
        <button className="ru-crash" onClick={() => outboard.crash()} title="Pancada na mola: o estrondo do reverb de mola">
          PANCADA
        </button>
      </MixSection>
      <MixSection title="Saída" className="echo-out">
        <Knob
          label="NÍVEL"
          value={o.echoLevel}
          min={0}
          max={1}
          reset={0.8}
          format={pct}
          onChange={(v) => outboard.update({ echoLevel: v })}
        />
      </MixSection>
    </div>
  )
}

/** Automatic dub: the deck playing is taken apart and put back together on the beat. */
function AutoDubControls() {
  const ad = useStore(autoDub)
  useStore(deckA)
  useStore(deckB)
  useStore(mixer)
  const live = liveDeck()
  const target = ad.on ? ad.deck : (live?.name ?? null)
  const ready = !!live && live.canStems
  return (
    <>
      <button
        className={'ru-adub-go' + (ad.on ? ' on' : '')}
        disabled={!ad.on && !ready}
        onClick={() => autoDub.toggle()}
        aria-pressed={ad.on}
        title={
          ad.on
            ? 'Parar: a música volta a como estava'
            : ready
              ? 'Liga: a app faz a versão dub do deck ' + live!.name + ' ao vivo'
              : 'Põe uma música (ficheiro) a tocar primeiro'
        }
      >
        <b>{ad.on ? 'PARAR' : 'AUTO'}</b>
        <span>{target ? 'deck ' + target : '—'}</span>
      </button>
      <div className="ru-seg" role="group" aria-label="Intensidade">
        {(Object.keys(DUB_LEVELS) as DubLevel[]).map((l) => (
          <button
            key={l}
            className={ad.level === l ? 'now' : ''}
            aria-pressed={ad.level === l}
            onClick={() => autoDub.setLevel(l)}
            title={DUB_LEVELS[l].hint}
          >
            {DUB_LEVELS[l].label}
          </button>
        ))}
      </div>
      <div className={'ru-adub-screen' + (ad.on ? ' on' : '')} aria-live="polite">
        <b>{ad.on ? ad.scene : ready ? 'Pronto' : 'À espera'}</b>
        <span>
          {ad.on
            ? (ad.doing ?? (ad.grid ? 'muda no início de cada frase' : 'sem grelha de batida: segue o andamento'))
            : ready
              ? 'carrega em AUTO para começar'
              : 'toca uma música'}
        </span>
      </div>
    </>
  )
}

/** The dub symbol: a speaker cone and its echo, repeating and fading out. */
function DubMark() {
  return (
    <svg className="dub-mark" viewBox="0 0 28 20" aria-hidden="true">
      <path d="M2 7h4l5-4v14l-5-4H2z" fill="currentColor" />
      <path d="M14 6.5a5 5 0 0 1 0 7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M17.5 4a9 9 0 0 1 0 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.6" />
      <path d="M21 1.5a13 13 0 0 1 0 17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" opacity="0.3" />
    </svg>
  )
}

/**
 * The rack between the waveforms and the decks: one DUB area across the whole width — the Dub Box
 * (noises, sounds, FIRE, throw) and the automatic dub — under one name and one symbol.
 */
export function Rack() {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = box.current
    if (!el) return
    const watch = new ResizeObserver(() => ui.setRack(el.offsetHeight))
    watch.observe(el)
    return () => watch.disconnect()
  }, [])
  return (
    <div className="rack dub-rack" ref={box}>
      <section className="dub-area" aria-label="Dub">
        <button className="dub-badge" onClick={() => ui.open('dubbox')} title="Dub: todos os ajustes no separador Dub Box, em baixo">
          <DubMark />
          <span>DUB</span>
        </button>
        <div className="dub-part dub-box">
          <DubBoxStrip />
        </div>
        <i className="dub-sep" aria-hidden="true" />
        <div className="dub-part dub-auto" role="group" aria-label="Dub automático">
          <AutoDubControls />
        </div>
      </section>
    </div>
  )
}
