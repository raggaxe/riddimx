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
import { PitchColumn } from './PitchColumn'
import { Scale } from './Meter'
import { Knob } from './Knob'
import { DUB_BEATS, DUB_LIMITS, dubSettings } from '../engine/dub'
import { outboard } from '../engine/outboard'
import { PAD_MODES, RIDDIM_PADS, padModes, riddimOn, riddimPad, type PadMode } from '../padmode'

const SOURCE_LABEL = { none: 'EMPTY', local: 'FILE', youtube: 'YOUTUBE', spotify: 'SPOTIFY' }
const STEM_LABEL: Record<Stem, string> = { vocal: 'VOCAL', instr: 'INSTR', bass: 'BASS', kick: 'KICK', hat: 'HAT' }
const FX_LABEL: Record<FxType, string> = { echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER', wah: 'WAH' }
const FX_NAME: Record<FxType, string> = { echo: 'Echo', reverb: 'Reverb', flanger: 'Flanger', wah: 'Wah' }
const FX_HINT: Record<FxType, string> = {
  echo: 'Echo in time with the music',
  reverb: 'Reverb: big room',
  flanger: 'Flanger: metallic sweep',
  wah: 'Wah: a filter that opens and closes',
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
  cue: 'Hot cue pads: jump to marked points',
  loop: 'Loop pads: IN / OUT, 1 bar, and auto loop from 1/16 beat to 8 bars',
  stems: 'Stem pads: take out or solo vocals, instruments, bass, kick and hats',
  riddim: 'Riddim pads: version (no vocals), acapella (vocals only), drum & bass, all',
}

/** 75.3 → "1:15" */
const clock = (seconds: number): string => Math.floor(seconds / 60) + ':' + String(Math.floor(seconds % 60)).padStart(2, '0')

/** Auto loop sizes, in beats: 1/16 beat up to 8 bars. */
const LOOP_SIZES = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32]

const loopLabel = (b: number): string =>
  b < 1 ? '1/' + Math.round(1 / b) : b < 4 ? b + (b === 1 ? ' BEAT' : ' BEATS') : b / 4 + (b === 4 ? ' BAR' : ' BARS')

const BAR_LOOPS = [4, 8, 16, 32] // 1, 2, 4, 8 bars

/** Bar loop: the button starts / ends a loop of the bars picked in the menu beside it. */
function BarLoop({ deck, beats, disabled }: { deck: Deck; beats: number | null; disabled: boolean }) {
  const key = 'vx_loop_bars_' + deck.name
  const [bars, setBars] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return BAR_LOOPS.includes(saved) ? saved : 4
    } catch {
      return 4
    }
  })
  const pick = (next: number) => {
    setBars(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      /* not remembered */
    }
    if (beats !== null && BAR_LOOPS.includes(beats)) deck.resizeLoop(next)
  }
  return (
    <div className={'pad loop bar-loop' + (beats === bars ? ' set' : '')}>
      <button disabled={disabled} onClick={() => deck.toggleLoop(bars)} title={'Loop of ' + loopLabel(bars).toLowerCase() + '. Click again to exit'}>
        {loopLabel(bars)}
      </button>
      <select value={bars} disabled={disabled} aria-label="Bar loop length" onChange={(e) => pick(Number(e.target.value))}>
        {BAR_LOOPS.map((b) => (
          <option key={b} value={b}>
            {loopLabel(b)}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Auto loop size: ‹ and › step through the sizes (and resize a running loop), the middle starts or
 * ends a loop of that size. The size is remembered per deck.
 */
function LoopSize({ deck, beats, disabled }: { deck: Deck; beats: number | null; disabled: boolean }) {
  const key = 'vx_loop_size_' + deck.name
  const [size, setSize] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(key))
      return LOOP_SIZES.includes(saved) ? saved : 4
    } catch {
      return 4
    }
  })
  const running = beats !== null && LOOP_SIZES.includes(beats) ? beats : null
  const shown = running ?? size
  const step = (dir: -1 | 1) => {
    const i = Math.max(0, Math.min(LOOP_SIZES.length - 1, LOOP_SIZES.indexOf(shown) + dir))
    const next = LOOP_SIZES[i]
    setSize(next)
    try {
      localStorage.setItem(key, String(next))
    } catch {
      /* not remembered */
    }
    if (beats !== null) deck.resizeLoop(next)
  }
  return (
    <div className="loop-size" role="group" aria-label="Auto loop size">
      <button
        className="pad loop arrow"
        disabled={disabled || shown === LOOP_SIZES[0]}
        onClick={() => step(-1)}
        aria-label="Shorter loop"
        title="Shorter (halves)"
      >
        ‹
      </button>
      <button
        className={'pad loop' + (running !== null && beats === shown ? ' set' : '')}
        disabled={disabled}
        onClick={() => deck.toggleLoop(shown)}
        title={'Auto loop of ' + loopLabel(shown).toLowerCase() + '. Click again to exit'}
      >
        {loopLabel(shown)}
      </button>
      <button
        className="pad loop arrow"
        disabled={disabled || shown === LOOP_SIZES[LOOP_SIZES.length - 1]}
        onClick={() => step(1)}
        aria-label="Longer loop"
        title="Longer (doubles)"
      >
        ›
      </button>
    </div>
  )
}

export function DeckView({ deck, other }: { deck: Deck; other: Deck }) {
  const s = useStore(deck)
  const dub = useStore(dubSettings)
  const echo = useStore(outboard)
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
              Look for another version
            </a>
          </>
        )}
      </p>
    )
  } else if (s.syncOn && (s.anchor === null || other.get().anchor === null)) {
    const missing = s.anchor === null ? s : other.get()
    message = (
      <p className="deck-msg">
        Tempo-only SYNC: the deck has no beat grid yet {s.anchor === null ? deck.name : other.name}.{' '}
        {missing.processed ? 'It is found by itself in a few seconds.' : 'Press TAP in time (4 times).'}
      </p>
    )
  } else if (streaming && searching) {
    message = <p className="deck-msg live">Looking for BPM…</p>
  } else if (streaming && notFound) {
    message = (
      <p className="deck-msg">
        {s.processed ? 'BPM not known yet: measured while playing (~20 s).' : 'BPM not found: set it with TAP.'}
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
      <div className="dk-top">
        <div className="dk-main">
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
              <strong key={empty ? '' : s.title}>{empty ? 'No track' : s.title}</strong>
              <span>
                {empty ? (
                  'Drag from the library or double-click a track'
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
                          '"' +
                          versions.name +
                          '": there are ' +
                          (versions.members.length - 1) +
                          ' more versions of this instrumental. Click to see them'
                        }
                      >
                        +{versions.members.length - 1} {versions.members.length === 2 ? 'version' : 'versions'}
                      </button>
                    )}
                    {s.loading ? <i className="dk-loading">loading…</i> : s.artist}
                  </>
                )}
              </span>
            </div>
            <button
              className="eject"
              disabled={empty || s.playing}
              onClick={() => deck.eject()}
              aria-label={'Eject the track from deck ' + deck.name}
              title={s.playing ? 'Stop the track to eject it' : 'Eject: take the track off the deck'}
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
                    title={
                      Math.abs(tempoGap) < 0.05 ? 'Same tempo as deck ' + other.name : 'BPM difference to deck ' + other.name
                    }
                  >
                    {Math.abs(tempoGap) < 0.05 ? '= ' + other.name : (tempoGap > 0 ? '+' : '−') + Math.abs(tempoGap).toFixed(1)}
                  </small>
                )}
                <strong
                  className={searching ? 'analyzing' : ''}
                  onClick={() => !empty && deck.resetBpm()}
                  title={
                    (s.bpm && Math.abs(s.rate - 1) > 0.0005
                      ? 'BPM with pitch (original ' + s.bpm.toFixed(1) + ')'
                      : 'Current BPM') + '. Click: analyse again'
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
                      ? 'Key heard now: the pitch moved the original key ' +
                        s.key +
                        ' by ' +
                        (shift > 0 ? '+' : '') +
                        shift +
                        ' semitone. Turn KEY on to keep it. '
                      : 'Track key and Camelot code. ') + (fits ? 'Mixes with the other deck.' : '')
                  }
                >
                  {heard ? heard + ' · ' + camelot(heard) : '—'}
                </em>
                <button
                  onClick={(e) => (e.shiftKey ? deck.markBar() : deck.tap())}
                  disabled={empty}
                  title="Tap the tempo in time with the music. Shift+click: this is the one of the bar"
                >
                  TAP
                </button>
                <button onClick={() => deck.scaleBpm(0.5)} disabled={!s.bpm} title="Half the BPM">
                  ½
                </button>
                <button onClick={() => deck.scaleBpm(2)} disabled={!s.bpm} title="Double the BPM">
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
                <div className="pad-modes" role="group" aria-label="Pad mode">
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
                  className={
                    'pad-set n' +
                    (mode === 'stems' ? 5 : mode === 'loop' ? 4 : 4) +
                    ' grid2' +
                    (mode === 'stems' ? ' g5' : mode === 'loop' ? ' g6' : '')
                  }
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
                            ? 'Hot cue ' + (i + 1) + ' at ' + clock(at) + '. Click: jump. Right-click or Shift+click: delete'
                            : 'Hot cue ' + (i + 1) + ' free. Click: set it here'
                        }
                      >
                        <b>{i + 1}</b>
                        {at !== null && <span>{clock(at)}</span>}
                      </button>
                    ))}
                  {mode === 'loop' && (
                    <>
                      <button
                        className={'pad loop' + (s.loopIn !== null ? ' set' : '')}
                        disabled={empty}
                        onClick={() => deck.loopIn()}
                        title="Loop IN: mark where the loop starts"
                      >
                        IN
                      </button>
                      <button
                        className={'pad loop' + (s.loop ? ' set' : '')}
                        disabled={empty || (s.loopIn === null && !s.loop)}
                        onClick={() => deck.loopOut()}
                        title="Loop OUT: close the loop here. While looping: exit"
                      >
                        OUT
                      </button>
                      <BarLoop deck={deck} beats={s.loop?.beats ?? null} disabled={empty} />
                      <LoopSize deck={deck} beats={s.loop?.beats ?? null} disabled={empty} />
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
                          (i < 3 ? '. Click again: the whole track comes back' : '') +
                          (s.aiStems === 'ready'
                            ? ' (stems IA)'
                            : s.aiStems === 'working'
                              ? ' (splitting with AI; filters until then)'
                              : '')
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
                              ? `Splitting with AI: ${Math.round(s.aiProgress * 100)}% (filters until then). `
                              : s.aiStems === 'error'
                                ? 'AI split failed; using filters. '
                                : '') + 'Click: take out / put back. Right-click or Shift+click: solo this part'
                        }
                      >
                        {STEM_LABEL[st]}
                      </button>
                    ))}
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
                    s.playing ? 'CUE: back to the cue point and stop' : 'CUE: set the cue here. Hold: play from it until released'
                  }
                >
                  CUE
                </button>
                <button
                  className={'btn play' + (s.playing ? ' on' : '')}
                  disabled={empty || s.loading}
                  onClick={() => deck.toggle()}
                  aria-label={s.playing ? 'Pause' : 'Play'}
                  title={s.playing ? 'Pause' : 'Play'}
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
                      ? 'SYNC needs the BPM of both decks'
                      : s.syncOn
                        ? 'Following deck ' + other.name + '. Click to release'
                        : 'Follows the tempo and beats of deck ' + other.name
                  }
                >
                  SYNC
                </button>
                <button
                  className="btn rew"
                  disabled={empty}
                  onClick={() => deck.rewind()}
                  aria-label="Rewind"
                  title="Rewind (pull up). Settings in Settings › Decks"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M8 3.5v9L1.5 8zM14.5 3.5v9L8 8z" fill="currentColor" />
                  </svg>
                </button>
              </div>
            </div>

            <Jog deck={deck} />
          </div>
        </div>
        <PitchColumn deck={deck} />
      </div>
      {/* Everything that colours this deck's sound, in one framed strip apart from the transport. */}
      <div
        className={'dk-fx' + (deck.canFx ? '' : ' off')}
        role="group"
        aria-label={'Deck ' + deck.name + ' effects'}
        title={deck.canFx ? '' : 'Effects work on files, and on YouTube clips in the desktop app'}
      >
        <span className="dk-fx-tag" aria-hidden="true">
          FX {deck.name}
        </span>
        <button
          className={'dk-fx-dub' + (s.dubbing ? ' on' : '')}
          disabled={!deck.canFx}
          aria-pressed={s.dubbing}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            deck.dubPress(true)
          }}
          onPointerUp={() => deck.dubPress(false)}
          onPointerCancel={() => s.dubbing && deck.dubPress(false)}
          title="DUB: throws this deck into a long echo. TIME, FDBK, TONE and SPRING change that echo live"
        >
          DUB
        </button>
        {/* The effect's name switches it on and off; the arrow beside it picks another one. */}
        <div className={'fx-pick' + (s.fxOn ? ' on' : '')}>
          <button
            className="fx-btn"
            disabled={!deck.canFx}
            aria-pressed={s.fxOn}
            onClick={() => deck.toggleFx()}
            title={FX_HINT[s.fx] + (s.fxOn ? '. Click to turn off' : '. Click to turn on')}
          >
            {FX_LABEL[s.fx]}
          </button>
          <label className="fx-choose" title="Pick the effect">
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
              aria-label="Pick the effect"
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
        <div className={'fx-knob' + (s.fxOn ? ' on' : '')} title="Effect amount (double-click: 50%)">
          <Knob label="FX" value={s.fxAmount} min={0} max={1} reset={0.5} format={pct} onChange={(v) => deck.setFxAmount(v)} />
        </div>
        {/* The DUB button's echo, played live: it changes an echo already ringing too (both decks share it). */}
        <div
          className="dk-dubk"
          title="The DUB echo, live: changes an echo already ringing too (shared by both decks). More in Settings › Decks"
        >
          <Knob
            label="TIME"
            value={Math.max(
              0,
              DUB_BEATS.findIndex((b) => b.value === dub.beats),
            )}
            min={0}
            max={DUB_BEATS.length - 1}
            reset={2}
            format={(v) => DUB_BEATS[Math.round(v)].label.replace(' beats', '').replace(' beat', '')}
            onChange={(v) => dubSettings.update({ beats: DUB_BEATS[Math.round(v)].value })}
          />
          <Knob
            label="FDBK"
            value={dub.feedback}
            min={DUB_LIMITS.feedback[0]}
            max={DUB_LIMITS.feedback[1]}
            reset={0.72}
            format={pct}
            onChange={(v) => dubSettings.update({ feedback: v })}
          />
          <Knob
            label="TONE"
            value={dub.tone}
            min={DUB_LIMITS.tone[0]}
            max={DUB_LIMITS.tone[1]}
            reset={3000}
            format={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '')}
            onChange={(v) => dubSettings.update({ tone: v })}
          />
          <Knob
            label="SPRING"
            value={dub.space}
            min={0}
            max={1}
            reset={0}
            format={pct}
            onChange={(v) => dubSettings.update({ space: v })}
          />
        </div>
        <button
          className={'dk-fx-throw' + (echo.throwing[deck.name as 'A' | 'B'] ? ' on' : '')}
          disabled={empty}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            outboard.throwPress(deck.name as 'A' | 'B', true)
          }}
          onPointerUp={() => outboard.throwPress(deck.name as 'A' | 'B', false)}
          onPointerCancel={() => outboard.throwPress(deck.name as 'A' | 'B', false)}
          title={
            echo.throwMode === 'bar'
              ? 'THROW into the tape echo: the music drops out, its last beat rings, it comes back on the next bar'
              : 'THROW into the tape echo while held'
          }
        >
          THROW
        </button>
      </div>
    </section>
  )
}
