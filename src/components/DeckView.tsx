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
import { PAD_MODES, padModes, samplerBase, type PadMode } from '../padmode'
import { sampler } from '../engine/sampler'

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

const SOURCE_LABEL = { none: 'VAZIO', local: 'FICHEIRO', youtube: 'YOUTUBE', spotify: 'SPOTIFY' }
const STEM_LABEL: Record<Stem, string> = { vocal: 'VOC', instr: 'INS', bass: 'BASS', kick: 'KICK', hat: 'HAT' }
const FX_LABEL: Record<FxType, string> = { echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER', wah: 'WAH' }
const FX_NAME: Record<FxType, string> = { echo: 'Echo', reverb: 'Reverb', flanger: 'Flanger', wah: 'Wah' }
const FX_HINT: Record<FxType, string> = {
  echo: 'Eco ao ritmo da música',
  reverb: 'Reverb: sala grande',
  flanger: 'Flanger: varrimento metálico',
  wah: 'Wah: filtro que abre e fecha',
}
const MODES = PAD_MODES
type Mode = PadMode
const MODE_LABEL: Record<Mode, string> = { cue: 'CUE', loop: 'LOOP', stems: 'STEMS', sampler: 'SAMPLER' }
const MODE_HINT: Record<Mode, string> = {
  cue: 'Pads de hot cue: saltar para pontos marcados',
  loop: 'Pads de loop: 4 e 8 batidas, manual, metade e dobro',
  stems: 'Pads de stems: tirar ou isolar voz, instrumentos, baixo, bombo e pratos',
  sampler: 'Pads do sampler: o deck A toca os sons 1 a 4, o deck B os sons 5 a 8',
}

/** 75.3 → "1:15" */
const clock = (seconds: number): string => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')

export function DeckView({ deck, other }: { deck: Deck; other: Deck }) {
  const s = useStore(deck)
  useStore(other) // re-render when the other deck's grid changes (sync hint)
  const bpm = useStore(bpmStore)
  const streaming = s.kind === 'youtube' || s.kind === 'spotify'
  const searching = !!s.ref && !s.bpm && (bpm.looking.includes(s.ref) || bpm.current === s.ref)
  const notFound = !!s.ref && !s.bpm && !searching && bpm.failed.includes(s.ref)
  const [over, setOver] = useState(false)
  // Shared with the controller: its pads follow this mode, and its mode buttons change it.
  const mode = useStore(padModes)[deck.name as 'A' | 'B']
  const setMode = (m: Mode) => padModes.setMode(deck.name as 'A' | 'B', m)
  // SAMPLER mode: this deck's four sampler pads (A: 1-4, B: 5-8).
  const base = samplerBase(deck.name)
  const mine = useStore(sampler).pads.slice(base, base + 4)
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
  const host = useCallback((el: HTMLDivElement | null) => deck.attachHost(el), [deck])
  const empty = s.kind === 'none'
  const pitch = (s.rate - 1) * 100
  const locked = s.kind === 'youtube' || (s.keyLock && deck.canKeyLock)
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
        SYNC só de tempo: falta a grelha de batidas no deck {s.anchor === null ? deck.name : other.name}.{' '}
        {missing.processed ? 'É detetada sozinha em alguns segundos.' : 'Carrega em TAP ao ritmo (4 vezes).'}
      </p>
    )
  } else if (streaming && searching) {
    message = <p className="deck-msg live">A procurar BPM…</p>
  } else if (streaming && notFound) {
    message = (
      <p className="deck-msg">
        {s.processed ? 'BPM ainda desconhecido: é medido ao tocar (~20 s).' : 'BPM não encontrado: marca com TAP.'}
      </p>
    )
  }

  return (
    <section
      className={`deck deck-${deck.name.toLowerCase()}${over ? ' over' : ''}`}
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
          {s.kind !== 'youtube' && (s.cover ? <img src={s.cover} alt="" /> : <span>{deck.name}</span>)}
          {(s.cover || s.kind === 'youtube') && <b className="dk-letter">{deck.name}</b>}
        </div>
        <div className="deck-title">
          <strong>{empty ? 'Sem música' : s.title}</strong>
          <span>
            {empty ? (
              'Arrasta da biblioteca ou dá duplo clique numa faixa'
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
                      '"' + versions.name + '": há mais ' + (versions.members.length - 1) + ' versões deste instrumental. Clica para as ver'
                    }
                  >
                    +{versions.members.length - 1} {versions.members.length === 2 ? 'versão' : 'versões'}
                  </button>
                )}
                {s.loading ? <i className="dk-loading">a carregar…</i> : s.artist}
              </>
            )}
          </span>
        </div>
        <button
          className="eject"
          disabled={empty || s.playing}
          onClick={() => deck.eject()}
          aria-label={'Ejetar a música do deck ' + deck.name}
          title={s.playing ? 'Pára a música para a poder ejetar' : 'Ejetar: tirar a música do deck'}
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
          <div>
            <em
              className={'key' + (fits ? ' match' : '') + (shift ? ' shifted' : '')}
              title={
                (shift
                  ? 'Tom ouvido agora: o pitch mudou o tom original ' +
                    s.key +
                    ' em ' +
                    (shift > 0 ? '+' : '') +
                    shift +
                    ' meio-tom. Liga o KEY para o manter. '
                  : 'Tom da música e código Camelot. ') + (fits ? 'Combina com o outro deck.' : '')
              }
            >
              {heard ? heard + ' · ' + camelot(heard) : '—'}
            </em>
            <button onClick={() => deck.tap()} disabled={empty} title="Marca o tempo ao ritmo da música">
              TAP
            </button>
            <button onClick={() => deck.scaleBpm(0.5)} disabled={!s.bpm} title="Metade do BPM">
              ½
            </button>
            <button onClick={() => deck.scaleBpm(2)} disabled={!s.bpm} title="Dobro do BPM">
              ×2
            </button>
          </div>
        </div>
      </header>

      <Waveform deck={deck} />
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
                        : mine.some((p) => p.playing)
                return (
                  <button
                    key={m}
                    className={'pad-mode-btn' + (mode === m ? ' now' : '') + (lit ? ' lit' : '')}
                    disabled={empty && m !== 'sampler'}
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    title={MODE_HINT[m]}
                  >
                    {MODE_LABEL[m]}
                  </button>
                )
              })}
            </div>
            <div
              className={'pad-set n' + (mode === 'stems' ? 5 : mode === 'loop' ? 6 : 4)}
              data-ai={mode === 'stems' ? s.aiStems : undefined}
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
                        ? 'Hot cue ' + (i + 1) + ' em ' + clock(at) + '. Clique: saltar. Botão direito ou Shift+clique: apagar'
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
              {mode === 'sampler' &&
                mine.map((p, i) => (
                  <button
                    key={i}
                    className={'pad samp' + (p.name ? ' loaded' : '') + (p.playing ? ' set' : '')}
                    onClick={(e) => (e.shiftKey ? sampler.stop(base + i) : p.name ? sampler.trigger(base + i) : undefined)}
                    disabled={!p.name}
                    title={p.name ? p.name + ': tocar / parar. Shift+clique: parar' : 'Pad ' + (base + i + 1) + ' do sampler vazio'}
                  >
                    <b>{base + i + 1}</b>
                    <span>{p.name ?? '—'}</span>
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
                          ? `A separar com IA: ${Math.round(s.aiProgress * 100)}% (até lá, filtros). `
                          : s.aiStems === 'error'
                            ? 'Separação IA falhou; a usar filtros. '
                            : '') + 'Clique: tirar / repor. Botão direito ou Shift+clique: ouvir só esta parte'
                    }
                  >
                    {STEM_LABEL[st]}
                  </button>
                ))}
            </div>
          </div>
          <div className={'dk-fx' + (deck.canFx ? '' : ' off')} title={deck.canFx ? '' : 'Efeitos só em ficheiros ou clipes YouTube'}>
            {/* The effect's name switches it on and off; the arrow beside it picks another one. */}
            <div className={'fx-pick' + (s.fxOn ? ' on' : '')}>
              <button
                className="fx-btn"
                disabled={!deck.canFx}
                aria-pressed={s.fxOn}
                onClick={() => deck.toggleFx()}
                title={FX_HINT[s.fx] + (s.fxOn ? '. Clica para desligar' : '. Clica para ligar')}
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
            <label className={'fx-amount' + (s.fxOn ? ' on' : '')} title="Quantidade de efeito (duplo clique: 50%)">
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={s.fxAmount}
                disabled={!deck.canFx}
                aria-label="Quantidade de efeito"
                style={{ '--v': s.fxAmount } as React.CSSProperties}
                onChange={(e) => deck.setFxAmount(Number(e.target.value))}
                onDoubleClick={() => deck.setFxAmount(0.5)}
              />
              <output>{Math.round(s.fxAmount * 100)}</output>
            </label>
            <button
              className={'pad dub' + (s.dubbing ? ' set' : '')}
              disabled={!deck.canFx}
              aria-pressed={s.dubbing}
              onPointerDown={() => deck.dubPress(true)}
              onPointerUp={() => deck.dubPress(false)}
              onPointerLeave={() => s.dubbing && deck.dubPress(false)}
              title="Dub: atira o som para um eco longo. Ajustes no separador Sampler"
            >
              DUB
            </button>
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
                s.playing ? 'CUE: voltar ao ponto de cue e parar' : 'CUE: marcar o cue aqui. Manter premido: ouvir a partir dele até largar'
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
                    ? 'A seguir o deck ' + other.name + '. Clica para soltar'
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
              title="Rewind (pull up). Ajustes no separador Sampler"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M8 3.5v9L1.5 8zM14.5 3.5v9L8 8z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>

        <Jog deck={deck} />

        <div className="dk-pitch">
          <div className="pitch-top">
            <button
              className={'pitch-read' + (Math.abs(pitch) < 0.05 ? ' zero' : '') + (s.syncOn ? ' synced' : '')}
              disabled={!deck.canPitch || Math.abs(pitch) < 0.05}
              onClick={() => deck.setRate(1)}
              title={s.syncOn ? 'Tempo seguido pelo SYNC' : 'Pitch em %. Clica para voltar a 0'}
              aria-label={'Pitch ' + pitch.toFixed(1) + '%. Repor a zero'}
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
              title="Alcance do pitch: clica para mudar (8, 16 ou 50%)"
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
              title={'Pitch ±' + range + '%: para baixo acelera (duplo clique: repor)'}
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
                      ? 'Key lock ligado: o tempo muda sem mudar o tom. Clica para desligar'
                      : 'Key lock desligado: o pitch muda também o tom' +
                        (shift ? ' (agora ' + (shift > 0 ? '+' : '') + shift + ' meio-tom)' : '') +
                        '. Clica para ligar'
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
                title="Travar: atrasa enquanto premido, cada vez mais (até 8%)"
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
                title="Empurrar: adianta enquanto premido, cada vez mais (até 8%)"
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
      </div>
    </section>
  )
}
