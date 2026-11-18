import { useCallback, useEffect, useRef, useState } from 'react'
import type { Deck } from '../engine/deck'
import { useStore } from '../store'
import { ui } from '../ui'
import { ENTRY_DRAG, RIDDIMS_ON, library } from '../library'
import { bpmStore } from '../engine/bpm'
import { STEMS, type Stem } from '../engine/stems'
import { FX, type FxType } from '../engine/fx'
import { camelot, harmonic } from '../engine/key'
import { Waveform } from './Waveform'
import { Jog } from './Jog'
import { Scale } from './Meter'
import { Knob } from './Knob'
import { DUB_BEATS, DUB_LIMITS, dubSettings } from '../engine/dub'
import { PAD_MODES, RIDDIM_PADS, padModes, riddimOn, riddimPad, type PadMode } from '../padmode'


const SOURCE_LABEL = { none: 'VAZIO', local: 'ARQUIVO', youtube: 'YOUTUBE', spotify: 'SPOTIFY' }
const STEM_LABEL: Record<Stem, string> = {
  vocal: 'VOCAL',
  instr: 'INSTR',
  bass: 'BASS',
  kick: 'KICK',
  hat: 'HAT',
}
const FX_LABEL: Record<FxType, string> = { echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER', wah: 'WAH' }
const FX_NAME: Record<FxType, string> = { echo: 'Echo', reverb: 'Reverb', flanger: 'Flanger', wah: 'Wah' }
const FX_HINT: Record<FxType, string> = {
  echo: 'Eco ao ritmo da música',
  reverb: 'Reverb: sala grande',
  flanger: 'Flanger: varredura metálico',
  wah: 'Wah: filtro que abre e fecha',
}
const MODES = PAD_MODES
type Mode = PadMode
const MODE_LABEL: Record<Mode, string> = { cue: 'CUE', loop: 'LOOP', stems: 'STEMS', riddim: 'RIDDIM' }
const pct = (v: number): string => Math.round(v * 100) + '%'
const icon = (d: string) => (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path d={d} />
  </svg>
)
/** Pad mode tabs under the wave: hot cue pin, loop arrows, stem faders, riddim wave. */
const MODE_ICON: Record<Mode, React.ReactNode> = {
  cue: icon('M8 14.5s-4.5-4.6-4.5-8a4.5 4.5 0 019 0c0 3.4-4.5 8-4.5 8zM8 8.2a1.7 1.7 0 100-3.4 1.7 1.7 0 000 3.4z'),
  loop: icon('M3 7.5V7a3 3 0 013-3h6.5M10.5 2l2 2-2 2M13 8.5V9a3 3 0 01-3 3H3.5M5.5 14l-2-2 2-2'),
  stems: icon('M4 2v12M8 2v12M12 2v12M2.5 10h3M6.5 5h3M10.5 8.5h3'),
  riddim: icon('M1.5 8h2l1.5-4 2 8 2-10 2 9 1.5-3h2'),
}
const MODE_HINT: Record<Mode, string> = {
  cue: 'Pads de hot cue: saltar para pontos marcados',
  loop: 'Pads de loop: 4 e 8 batidas, manual, metade e dobro',
  stems: 'Pads de stems: tirar ou isolar voz, instrumentos, baixo, bumbo e pratos',
  riddim: 'Pads de riddim: version (sem voz), acapella (só voz), drum & bass, tudo',
}

/** 75.3 → "1:15" */
const clock = (seconds: number): string => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')

export function DeckView({ deck, other }: { deck: Deck; other: Deck }) {
  const s = useStore(deck)
  const dub = useStore(dubSettings)
  useStore(other) // re-render when the other deck's grid changes (sync hint)
  const bpm = useStore(bpmStore)
  const streaming = s.kind === 'youtube' || s.kind === 'spotify'
  const searching = !!s.ref && !s.bpm && (bpm.looking.includes(s.ref) || bpm.current === s.ref)
  const notFound = !!s.ref && !s.bpm && !searching && bpm.failed.includes(s.ref)
  const [over, setOver] = useState(false)
  // Shared with the controller: its pads follow this mode, and its mode buttons change it.
  const mode = useStore(padModes)[deck.name as 'A' | 'B']
  const setMode = (m: Mode) => padModes.setMode(deck.name as 'A' | 'B', m)
  const host = useCallback((el: HTMLDivElement | null) => deck.attachHost(el), [deck])
  const empty = s.kind === 'none'
  const pitch = (s.rate - 1) * 100
  // Key the crowd hears (the pitch fader moves it when key lock is off) and whether it fits the other deck's.
  // The track's riddim, when the library knows other versions of its instrumental.
  const lib = useStore(library)
  const entryId = lib.onDeck[deck.name]
  const versions = RIDDIMS_ON && entryId && s.kind !== 'none' ? library.riddimOf(entryId) : null
  const heard = deck.heardKey
  const o = other.get()
  const tempoGap = s.bpm && o.bpm && o.kind !== 'none' ? s.bpm * s.rate - o.bpm * o.rate : null
  const shift = deck.keyShift
  const fits = harmonic(heard, other.heardKey)


  // One line at most, most important first.
  let message: React.ReactNode = null
  if (s.error) {
    message = (
      <p className="deck-msg error">
        {s.error}
        {s.blocked && (
          <>
            {' '}
            <a
              className="link"
              target="_blank"
              rel="noreferrer"
              href={
                'https://www.youtube.com/results?search_query=' +
                encodeURIComponent((/^YouTube [\w-]+$/.test(s.title) ? '' : s.title + ' ') + 'audio')
              }
            >
              Procurar outra versão
            </a>
          </>
        )}
      </p>
    )
  } else if (s.syncOn && (s.anchor === null || other.get().anchor === null)) {
    const missing = s.anchor === null ? s : other.get()
    message = (
      <p className="deck-msg">
        SYNC só de tempo: falta a grid de batidas no deck {s.anchor === null ? deck.name : other.name}.{' '}
        {missing.processed ? 'É detetada sozinha em alguns segundos.' : 'Aperte TAP ao ritmo (4 vezes).'}
      </p>
    )
  } else if (streaming && searching) {
    message = <p className="deck-msg live">Procurando BPM…</p>
  } else if (streaming && notFound) {
    message = (
      <p className="deck-msg">
        {s.processed ? 'BPM ainda desconhecido: é medido ao tocar (~20 s).' : 'BPM não encontrado: marca com TAP.'}
      </p>
    )
  }

  return (
    <section
      className={`deck dv2 deck-${deck.name.toLowerCase()}${over ? ' over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        const dragged = library.byId(e.dataTransfer.getData(ENTRY_DRAG))
        const [entry] = dragged ? [dragged] : library.addFiles(Array.from(e.dataTransfer.files))
        if (entry) library.load(entry, deck)
      }}
    >
      <header className="dk-head">
        {/* Cover: the clip itself for YouTube (its player must stay on screen), the deck letter otherwise. */}
        <div className="dk-cover">
          <div className="yt-box" hidden={s.kind !== 'youtube'}>
            <div className="yt-inner" ref={host} />
          </div>
          {s.kind !== 'youtube' && (s.cover ? <img key={s.cover} src={s.cover} alt="" /> : <span>{deck.name}</span>)}
          {(s.cover || s.kind === 'youtube') && <b className="dk-letter">{deck.name}</b>}
        </div>
        <div className="deck-title">
          {/* Keyed by the title: a new track fades in instead of swapping in place. */}
          <strong key={empty ? '' : s.title}>{empty ? 'Sem música' : s.title}</strong>
          <span>
            {empty ? (
              'Arraste da biblioteca ou dê duplo clique numa faixa'
            ) : (
              <>
                {/* With other versions of its riddim, that matters more than where the file came from. */}
                {!versions && <em className={'badge ' + s.kind}>{SOURCE_LABEL[s.kind]}</em>}
                {versions && (
                  <button
                    className="dk-riddim"
                    onClick={() => {
                      ui.open('library')
                      library.showRiddim(versions.key)
                    }}
                    title={
                      '"' + versions.name + '": há mais ' + (versions.members.length - 1) + ' versões deste instrumental. Clique para ver'
                    }
                  >
                    +{versions.members.length - 1} {versions.members.length === 2 ? 'versão' : 'versões'}
                  </button>
                )}
                {s.loading ? <i className="dk-loading">carregando…</i> : s.artist}
              </>
            )}
          </span>
        </div>
        <button
          className="eject"
          disabled={empty || s.playing}
          onClick={() => deck.eject()}
          aria-label={'Ejetar a música do deck ' + deck.name}
          title={s.playing ? 'Pare a música para poder ejetar' : 'Ejetar: tirar a música do deck'}
        >
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
            <path d="M6 2l4 5H2z M2 9h8v1.5H2z" fill="currentColor" />
          </svg>
        </button>
        <div className="bpm">
          <div className="bpm-top">
            {/* Tempo against the other deck: "= B" when they match, otherwise how far off it is. */}
            {tempoGap !== null && (
              <small
                className={'bpm-gap' + (Math.abs(tempoGap) < 0.05 ? ' same' : '')}
                title={Math.abs(tempoGap) < 0.05 ? 'Mesmo tempo que o deck ' + other.name : 'Diferença de BPM para o deck ' + other.name}
              >
                {Math.abs(tempoGap) < 0.05 ? '= ' + other.name : (tempoGap > 0 ? '+' : '−') + Math.abs(tempoGap).toFixed(1)}
              </small>
            )}
            <strong
              className={searching ? 'analyzing' : ''}
              onClick={() => !empty && deck.resetBpm()}
              title={
                (s.bpm && Math.abs(s.rate - 1) > 0.0005 ? 'BPM com o pitch (original ' + s.bpm.toFixed(1) + ')' : 'BPM atual') +
                '. Clique: analisar de novo'
              }
            >
              {s.bpm ? (s.bpm * s.rate).toFixed(1) : '--.-'}
            </strong>
          </div>
          <small className="bpm-unit">BPM</small>
        </div>
      </header>

      <Waveform
        deck={deck}
        info={
          <div className="dk-keytap">
            <em
              className={'key' + (fits ? ' match' : '') + (shift ? ' shifted' : '')}
              title={
                (shift
                  ? 'Tom ouvido agora: o pitch mudou o tom original ' +
                    s.key +
                    ' em ' +
                    (shift > 0 ? '+' : '') +
                    shift +
                    ' meio-tom. Ligue o KEY para manter. '
                  : 'Tom da música e código Camelot. ') + (fits ? 'Combina com o outro deck.' : '')
              }
            >
              {heard ? heard + ' · ' + camelot(heard) : '—'}
            </em>
            <button
              onClick={(e) => (e.shiftKey ? deck.markBar() : deck.tap())}
              disabled={empty}
              title="Marca o tempo ao ritmo da música. Shift+clique: aqui é o 1 do compasso"
            >
              TAP
            </button>
            <button onClick={() => deck.scaleBpm(0.5)} disabled={!s.bpm} title="Metade do BPM">
              ½
            </button>
            <button onClick={() => deck.scaleBpm(2)} disabled={!s.bpm} title="Dobro do BPM">
              ×2
            </button>
          </div>
        }
      />
      <div className="dk-msg">{message}</div>

      <div className="dk-body">
        <div className="dk-pads">
          {/* One row of pads; the button on the left switches what they do. */}
          <div className="dk-row">
            {/* What the pads do, one click each; a dot marks a mode that holds something (cues set, loop on, stem cut). */}
            <div className="pad-modes" role="group" aria-label="Função dos pads">
              {MODES.map((m) => {
                const lit =
                  m === 'cue'
                    ? s.hotcues.some((c) => c !== null)
                    : m === 'loop'
                      ? !!s.loop
                      : m === 'stems'
                        ? Object.values(s.stems).some((on) => !on)
                        : RIDDIM_PADS.some((_, i) => i < 3 && riddimOn(s.stems, i))
                return (
                  <button
                    key={m}
                    className={'pad-mode-btn' + (mode === m ? ' now' : '') + (lit ? ' lit' : '')}
                    disabled={empty}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    title={MODE_HINT[m]}
                  >
                    {MODE_ICON[m]}
                    <span>{MODE_LABEL[m]}</span>
                  </button>
                )
              })}
            </div>
            <div
              className={'pad-set n' + (mode === 'stems' ? 5 : mode === 'loop' ? 6 : 4) + ' grid2' + (mode === 'stems' ? ' g5' : mode === 'loop' ? ' g6' : '')}
              data-ai={mode === 'stems' || mode === 'riddim' ? s.aiStems : undefined}
              style={{ '--ai': s.aiProgress } as React.CSSProperties}
            >
              {mode === 'cue' &&
                s.hotcues.map((at, i) => (
                  <button
                    key={i}
                    className={`pad hc${i}${at !== null ? ' set' : ''}`}
                    disabled={empty}
                    onClick={(e) => (e.shiftKey ? deck.clearHotcue(i) : deck.hotcue(i))}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      deck.clearHotcue(i)
                    }}
                    title={
                      at !== null
                        ? 'Hot cue ' + (i + 1) + ' em ' + clock(at) + '. Clique: pular. Botão direito ou Shift+clique: apagar'
                        : 'Hot cue ' + (i + 1) + ' livre. Clique: marcar aqui'
                    }
                  >
                    <b>{i + 1}</b>
                    {at !== null && <span>{clock(at)}</span>}
                  </button>
                ))}
              {mode === 'loop' && (
                <>
                  {[4, 8].map((beats) => (
                    <button
                      key={beats}
                      className={'pad loop' + (s.loop?.beats === beats ? ' set' : '')}
                      disabled={empty}
                      onClick={() => deck.toggleLoop(beats)}
                      title={'Loop de ' + beats + ' batidas'}
                    >
                      {beats}
                    </button>
                  ))}
                  <button
                    className={'pad loop' + (s.loopIn !== null ? ' set' : '')}
                    disabled={empty}
                    onClick={() => deck.loopIn()}
                    title="Loop manual: marcar o início"
                  >
                    IN
                  </button>
                  <button
                    className={'pad loop' + (s.loop && ![4, 8].includes(s.loop.beats) ? ' set' : '')}
                    disabled={empty || (s.loopIn === null && !s.loop)}
                    onClick={() => deck.loopOut()}
                    title="Loop manual: fechar aqui. Durante um loop: sair"
                  >
                    OUT
                  </button>
                  <button className="pad loop" disabled={!s.loop} onClick={() => deck.loopScale(0.5)} title="Loop para metade">
                    ½
                  </button>
                  <button className="pad loop" disabled={!s.loop} onClick={() => deck.loopScale(2)} title="Loop para o dobro">
                    ×2
                  </button>
                </>
              )}
              {mode === 'riddim' &&
                RIDDIM_PADS.map((r, i) => (
                  <button
                    key={r.label}
                    className={'pad riddim r' + i + (i < 3 && riddimOn(s.stems, i) ? ' set' : '')}
                    disabled={!deck.canStems}
                    aria-pressed={i < 3 ? riddimOn(s.stems, i) : undefined}
                    onClick={() => riddimPad(deck, i)}
                    title={
                      r.hint +
                      (i < 3 ? '. Clique outra vez: a música inteira volta' : '') +
                      (s.aiStems === 'ready' ? ' (stems IA)' : s.aiStems === 'working' ? ' (separando com IA; até lá, filtros)' : '')
                    }
                    aria-label={r.label}
                  >
                    <span className="rl">{r.label}</span>
                    <span className="rs" aria-hidden>
                      {r.short}
                    </span>
                  </button>
                ))}
              {mode === 'stems' &&
                STEMS.map((st) => (
                  <button
                    key={st}
                    className={'pad stem' + (s.stems[st] ? ' set' : '')}
                    disabled={!deck.canStems}
                    aria-pressed={s.stems[st]}
                    onClick={(e) => (e.shiftKey ? deck.soloStem(st) : deck.toggleStem(st))}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      deck.soloStem(st)
                    }}
                    title={
                      (s.aiStems === 'ready'
                        ? 'Stems IA. '
                        : s.aiStems === 'working'
                          ? `Separando com IA: ${Math.round(s.aiProgress * 100)}% (até lá, filtros). `
                          : s.aiStems === 'error'
                            ? 'Separação IA falhou; usando filtros. '
                            : '') + 'Clique: tirar / pôr de volta. Botão direito ou Shift+clique: ouvir só esta parte'
                    }
                  >
                    {STEM_LABEL[st]}
                  </button>
                ))}
            </div>
          </div>
          <div className={'dk-fx' + (deck.canFx ? '' : ' off')} title={deck.canFx ? '' : 'Efeitos só em arquivos ou clipes YouTube'}>
            {/* The effect's name switches it on and off; the arrow beside it picks another one. */}
            <div className={'fx-pick' + (s.fxOn ? ' on' : '')}>
              <button
                className="fx-btn"
                disabled={!deck.canFx}
                aria-pressed={s.fxOn}
                onClick={() => deck.toggleFx()}
                title={FX_HINT[s.fx] + (s.fxOn ? '. Clique para desligar' : '. Clique para ligar')}
              >
                {FX_LABEL[s.fx]}
              </button>
              <label className="fx-choose" title="Escolher o efeito">
                <svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true">
                  <path
                    d="M2 3.5L5 6.5 8 3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <select
                  value={s.fx}
                  disabled={!deck.canFx}
                  aria-label="Escolher o efeito"
                  onChange={(e) => deck.setFx(e.target.value as FxType)}
                >
                  {FX.map((fx) => (
                    <option key={fx} value={fx}>
                      {FX_NAME[fx]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className={'fx-knob' + (s.fxOn ? ' on' : '')} title="Quantidade de efeito (duplo clique: 50%)">
              <Knob label="FX" value={s.fxAmount} min={0} max={1} reset={0.5} format={pct} onChange={(v) => deck.setFxAmount(v)} />
            </div>
            {/* The DUB button's echo, played live: it changes an echo already ringing too (both decks share it). */}
            <div className="dk-dubk" title="DUB ao vivo: mexe no eco do botão DUB, mesmo depois de jogar o som (vale para os dois decks). Mais ajustes em Ajustes › Decks">
              <Knob
                label="TEMPO"
                value={Math.max(0, DUB_BEATS.findIndex((b) => b.value === dub.beats))}
                min={0}
                max={DUB_BEATS.length - 1}
                reset={2}
                format={(v) => DUB_BEATS[Math.round(v)].label.replace(' batidas', '').replace(' batida', '')}
                onChange={(v) => dubSettings.update({ beats: DUB_BEATS[Math.round(v)].value })}
              />
              <Knob
                label="REP"
                value={dub.feedback}
                min={DUB_LIMITS.feedback[0]}
                max={DUB_LIMITS.feedback[1]}
                reset={0.72}
                format={pct}
                onChange={(v) => dubSettings.update({ feedback: v })}
              />
              <Knob
                label="BRILHO"
                value={dub.tone}
                min={DUB_LIMITS.tone[0]}
                max={DUB_LIMITS.tone[1]}
                reset={3000}
                format={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '')}
                onChange={(v) => dubSettings.update({ tone: v })}
              />
              <Knob
                label="MOLA"
                value={dub.space}
                min={0}
                max={1}
                reset={0}
                format={pct}
                onChange={(v) => dubSettings.update({ space: v })}
              />
            </div>
          </div>
          <div className="dk-transport">
            <button
              className={'btn cue' + (deck.atCue ? ' at' : '')}
              disabled={empty}
              onPointerDown={(e) => {
                if (e.button !== 0) return
                e.currentTarget.setPointerCapture(e.pointerId)
                deck.cueDown()
              }}
              onPointerUp={() => deck.cueUp()}
              onPointerCancel={() => deck.cueUp()}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && !e.repeat && (e.preventDefault(), deck.cueDown())}
              onKeyUp={(e) => (e.key === ' ' || e.key === 'Enter') && deck.cueUp()}
              title={
                s.playing ? 'CUE: voltar ao ponto de cue e parar' : 'CUE: marcar o cue aqui. Segure: ouvir a partir dele até soltar'
              }
            >
              CUE
            </button>
            <button
              className={'btn play' + (s.playing ? ' on' : '')}
              disabled={empty || s.loading}
              onClick={() => deck.toggle()}
              aria-label={s.playing ? 'Pausa' : 'Tocar'}
              title={s.playing ? 'Pausa' : 'Tocar'}
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                {s.playing ? (
                  <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />
                ) : (
                  <path d="M4.5 2.8v10.4a.5.5 0 00.77.42l8-5.2a.5.5 0 000-.84l-8-5.2a.5.5 0 00-.77.42z" fill="currentColor" />
                )}
              </svg>
            </button>
            <button
              className={'btn sync' + (s.syncOn ? ' on' : '')}
              disabled={empty || (!s.syncOn && (!s.bpm || !other.get().bpm))}
              aria-pressed={s.syncOn}
              onClick={() => deck.sync(other)}
              title={
                !s.bpm || !other.get().bpm
                  ? 'SYNC precisa do BPM dos dois decks'
                  : s.syncOn
                    ? 'Seguindo o deck ' + other.name + '. Clique para soltar'
                    : 'Segue o tempo e as batidas do deck ' + other.name
              }
            >
              SYNC
            </button>
            <button
              className="btn rew"
              disabled={empty}
              onClick={() => deck.rewind()}
              aria-label="Rewind"
              title="Rewind (pull up). Ajustes em Ajustes › Decks"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 3.5v9L1.5 8zM14.5 3.5v9L8 8z" fill="currentColor" />
              </svg>
            </button>
            <button
              className={'btn dub' + (s.dubbing ? ' on' : '')}
              disabled={!deck.canFx}
              aria-pressed={s.dubbing}
              onPointerDown={() => deck.dubPress(true)}
              onPointerUp={() => deck.dubPress(false)}
              onPointerLeave={() => s.dubbing && deck.dubPress(false)}
              title="DUB: joga o som num eco longo. Os knobs TEMPO, REP, BRILHO e MOLA mexem no eco ao vivo"
            >
              DUB
            </button>
          </div>
        </div>

        <Jog deck={deck} />
      </div>

    </section>
  )
}
