import { useEffect, useRef, useState } from 'react'
import { AUX_FX, DUB_SCENES, plugin, type AuxFx } from '../engine/plugin'
import { DUB_PADS, dubAi } from '../engine/dubai'
import { decks, type Deck } from '../engine/deck'
import { RIDDIM_PADS, riddimOn, riddimPad } from '../padmode'
import { STEMS, type Stem } from '../engine/stems'
import { useStore } from '../store'
import { Knob } from './Knob'

const pct = (v: number) => Math.round(v * 100) + '%'
const STEM_NAME: Record<Stem, string> = { vocal: 'VOCAL', instr: 'INSTR', bass: 'BASS', kick: 'KICK', hat: 'HATS' }

/** One deck's stems: each part's volume, and under it the same quick cut as the deck's stem pads. */
function StemDeck({ deck }: { deck: Deck }) {
  const s = useStore(deck)
  const d = deck.name as 'A' | 'B'
  const can = deck.canStems
  return (
    <div
      className={'plg2-deckstems ' + d.toLowerCase() + (can ? '' : ' off')}
      title={can ? undefined : 'Deck ' + d + ': stems work on files (and YouTube in the desktop app)'}
    >
      <div className={'plg2-row stems ' + d.toLowerCase() + (can ? '' : ' off')}>
        <em title={'Deck ' + d}>{d}</em>
        {STEMS.map((st) => (
          <div key={st} className="plg2-stem" title={STEM_NAME[st] + ' volume ' + pct(s.stemVol[st])}>
            <Knob label={pct(s.stemVol[st])} value={s.stemVol[st]} min={0} max={1} reset={1} format={pct} onChange={(v) => deck.setStemVol(st, v)} />
            <button
              className={'plg2-key' + (s.stems[st] ? ' on' : '')}
              aria-pressed={s.stems[st]}
              disabled={!can}
              title={STEM_NAME[st] + ': click takes it out / puts it back (same as the deck pad). Right-click or Shift+click: solo'}
              onClick={(e) => (e.shiftKey ? deck.soloStem(st) : deck.toggleStem(st))}
              onContextMenu={(e) => {
                e.preventDefault()
                deck.soloStem(st)
              }}
            >
              {STEM_NAME[st]}
            </button>
          </div>
        ))}
      </div>
      {/* The deck's RIDDIM pads: the song taken apart in one press (pressed again: all back). */}
      <div className="plg2-riddim" role="group" aria-label={'Deck ' + d + ' riddim'}>
        {RIDDIM_PADS.map((r, i) => (
          <button
            key={r.label}
            className={'plg2-key' + (i < 3 && riddimOn(s.stems, i) ? ' on' : '')}
            aria-pressed={i < 3 ? riddimOn(s.stems, i) : undefined}
            disabled={!can}
            title={r.hint + (i < 3 ? '. Press again: the whole track comes back' : '')}
            onClick={() => riddimPad(deck, i)}
          >
            {r.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Left column: each stem's own volume and quick cut, per deck (the sends of both AUX hear them). */
function StemsColumn() {
  return (
    <section className="plg2-stems" aria-label="Stem volumes and cuts">
      <header className="plg2-head">
        <b>STEMS</b>
        <span className="plg2-sub">volume · cut</span>
      </header>
      <div className="plg2-sends">
        {decks.map((deck) => (
          <StemDeck key={deck.name} deck={deck} />
        ))}
      </div>
    </section>
  )
}

/** The effect of one AUX: a key that shows it and opens the list of all of them. */
function FxPicker({ i, fx }: { i: number; fx: AuxFx }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [open])
  const now = AUX_FX.find((f) => f.id === fx)!
  return (
    <div className="plg2-pick" ref={box}>
      <button className={'plg2-pick-now' + (open ? ' open' : '')} aria-haspopup="listbox" aria-expanded={open} title={now.hint} onClick={() => setOpen(!open)}>
        {now.label}
        <svg viewBox="0 0 10 6" width="8" height="5" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
      {open && (
        <div className="plg2-pick-list" role="listbox" aria-label={'AUX ' + (i + 1) + ' effect'}>
          {AUX_FX.map((f) => (
            <button
              key={f.id}
              role="option"
              aria-selected={f.id === fx}
              className={f.id === fx ? 'on' : ''}
              title={f.hint}
              onClick={() => {
                plugin.updateAux(i, { fx: f.id })
                setOpen(false)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Right column: ready-made dub scenes, and the AI pads that ride the sends live. */
function DubColumn() {
  const p = useStore(plugin)
  const ai = useStore(dubAi)
  const any = Object.values(ai.on).some(Boolean)
  const said = ai.doing ?? ai.note ?? (any ? (ai.deck ? 'listening to deck ' + ai.deck : 'waiting for a deck to play') : 'off')
  return (
    <section className="plg2-dub" aria-label="Dub scenes and AI dub">
      <header className="plg2-head">
        <b>
          <i className={any ? 'on' : ''} aria-hidden="true" />
          DUB
        </b>
        <span className={'plg2-sub' + (ai.doing ? ' doing' : '')} role="status">
          {said}
        </span>
      </header>
      <div>
        <small>SCENES</small>
        <div className="plg2-grid">
          {DUB_SCENES.map((sc) => (
            <button
              key={sc.id}
              className={'plg2-key' + (p.scene === sc.id ? ' on' : '')}
              aria-pressed={p.scene === sc.id}
              title={
                p.scene === sc.id
                  ? sc.label + ' is on. Press again to take it off: everything goes back to how it was before'
                  : sc.hint + '. Press again to take it off'
              }
              onClick={() => plugin.applyScene(sc.id)}
            >
              {sc.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <small>AI DUB</small>
        <div className="plg2-grid pads">
          {DUB_PADS.map((pad) => (
            <button
              key={pad.id}
              className={'plg2-key pad' + (ai.on[pad.id] ? ' on' : '') + (pad.id === 'auto' ? ' wide' : '')}
              aria-pressed={ai.on[pad.id]}
              title={pad.hint}
              onClick={() => dubAi.toggle(pad.id)}
            >
              {pad.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * FX tab (bottom; was "Plugin"): two AUX effects fed by the stems. Each knob in the grid sends one stem of one deck
 * (after its fader) into that AUX; the AUX returns into the master. Laid out in the house pattern of the bottom
 * tabs (see Master): the two AUX units side by side on one surface, a hairline between them; in each, the effect's
 * knobs on top and the stem sends under them. On the right, dub scenes and the AI dub pads.
 */
export function PluginPanel() {
  const p = useStore(plugin)
  return (
    <div className="plg2">
      <StemsColumn />
      {p.aux.map((aux, i) => {
        const fx = AUX_FX.find((f) => f.id === aux.fx)!
        const sends = (['A', 'B'] as const).flatMap((d) => STEMS.filter((st) => p.send[i][d][st] > 0).map((st) => d + ' ' + STEM_NAME[st]))
        const sending = sends.length > 0
        return (
          <section key={i} className={'plg2-unit' + (sending ? ' on' : '')} aria-label={'AUX ' + (i + 1)}>
            <header className="plg2-head">
              <b>
                <i className={sending ? 'on' : ''} aria-hidden="true" />
                AUX {i + 1}
              </b>
              <FxPicker i={i} fx={aux.fx} />
              <span className="plg2-sub" title={sends.join(', ')}>
                {sending ? 'sending ' + (sends.length === 1 ? sends[0] : sends.length + ' stems') : 'nothing sent'}
              </span>
              <button className="plg2-key clear" disabled={!sending} onClick={() => plugin.clearSends(i)} title="Every send of this AUX back to zero">
                CLEAR
              </button>
            </header>
            <div className="plg2-body">
              <div>
                <small>{fx.label.toUpperCase()}</small>
                <div className="plg2-params" role="group" aria-label={fx.label + ' settings'}>
                  <Knob label={fx.a} value={aux.a} min={0} max={1} reset={0.5} format={fx.fmtA ?? pct} onChange={(v) => plugin.updateAux(i, { a: v })} />
                  <Knob label={fx.b} value={aux.b} min={0} max={1} reset={0.5} format={pct} onChange={(v) => plugin.updateAux(i, { b: v })} />
                  <Knob label="RETURN" value={aux.ret} min={0} max={1} reset={0.7} format={pct} onChange={(v) => plugin.updateAux(i, { ret: v })} />
                </div>
              </div>
              <div>
                <small>STEM SENDS</small>
                <div className="plg2-sends" role="group" aria-label={'Stem sends into AUX ' + (i + 1)}>
                  {(['A', 'B'] as const).map((d) => (
                    <div key={d} className={'plg2-row ' + d.toLowerCase()}>
                      <em title={'Deck ' + d}>{d}</em>
                      {STEMS.map((st) => (
                        <Knob
                          key={st}
                          label={STEM_NAME[st]}
                          value={p.send[i][d][st]}
                          min={0}
                          max={1}
                          reset={0}
                          format={pct}
                          onChange={(v) => plugin.setSend(i, d, st, v)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )
      })}
      <DubColumn />
      <p className="plg2-note">
        Sends follow each deck's fader, its stem cuts and volumes. The AI dub listens to the stems of the deck on air (best with AI stems).
      </p>
    </div>
  )
}
