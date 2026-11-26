import { mixer } from '../engine/mixer'
import { MasterIsolator, MicSection, SoundSystem, VuPair } from './MasterStrip'
import { deckA, deckB, type Deck } from '../engine/deck'
import { useStore } from '../store'
import { Knob } from './Knob'
import { DB_MARKS, FADER_MARKS, Meter, Scale } from './Meter'
import { DUB_PRESET_DRAG, PATCH_LIMITS, dubBox } from '../engine/dubbox'
import { sampler } from '../engine/sampler'
import { ui, type Centre } from '../ui'
import { DubPage, EchoPage, FxSide, MicPage, TapePage } from './CentrePages'
import { DubSoundMenu } from './DubSoundMenu'
import { useState } from 'react'
import logo from '../assets/riddimx-x.svg'
import { TransitionMoves, TransitionRoute, TransitionTiming } from './Transitions'

/** Readouts while a knob turns, matching what the deck does with the value. */
const eqDb = (v: number): string => (v <= -0.99 ? 'KILL' : (v >= 0 ? '+' : '') + (v < 0 ? v * 30 : v * 8).toFixed(1) + ' dB')
const gainDb = (v: number): string => (v >= 0 ? '+' : '') + (v * 12).toFixed(1) + ' dB'
const filterText = (v: number): string =>
  Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? 'LP ' + Math.round(-v * 100) + '%' : 'HP ' + Math.round(v * 100) + '%'
const pct = (v: number): string => Math.round(v * 100) + '%'

/** Position 0..1 on a logarithmic range, and back. */
const toLog = (hz: number, lo: number, hi: number): number => Math.log(hz / lo) / Math.log(hi / lo)
const fromLog = (v: number, lo: number, hi: number): number => lo * Math.pow(hi / lo, v)

const phones = (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d="M4 15v-3a8 8 0 0 1 16 0v3M4 14h3v6H5a1 1 0 0 1-1-1v-5Zm16 0h-3v6h2a1 1 0 0 0 1-1v-5Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinejoin="round"
    />
  </svg>
)

/** One channel: EQ and filter on top, the channel fader, and the headphone (pre-listen) button. */
function Strip({ deck }: { deck: Deck }) {
  const s = useStore(deck)
  // EQ and filter only act on local files, and on YouTube clips when the desktop app routes their sound.
  const bypassed = (s.kind === 'youtube' && !s.processed) || s.kind === 'spotify'
  const side = deck.name.toLowerCase()
  return (
    <div className={`strip strip-${side}`}>
      <div className="strip-head">
        <span className="ch-tag">{deck.name}</span>
        <div className={'gain' + (bypassed ? ' bypassed' : '')}>
          <Knob label="GAIN" value={s.gain} format={gainDb} onChange={(v) => deck.setGain(v)} />
        </div>
        <button
          className={'pfl' + (s.pfl ? ' on' : '')}
          aria-pressed={s.pfl}
          aria-label={'Pre-listen deck ' + deck.name + ' in the headphones'}
          title="Pre-listen: hear this deck in the headphones"
          onClick={() => deck.togglePfl()}
        >
          {phones}
        </button>
      </div>
      {/* EQ in one column beside the fader, so the fader can use the strip's whole height. */}
      <div className="strip-body">
        <div
          className={'eq-grid' + (bypassed ? ' bypassed' : '')}
          title={bypassed ? 'Not available for YouTube/Spotify outside the desktop app' : ''}
        >
          <Knob label="HIGH" value={s.high} format={eqDb} onChange={(v) => deck.setEq('high', v)} />
          <Knob label="MID" value={s.mid} format={eqDb} onChange={(v) => deck.setEq('mid', v)} />
          <Knob label="LOW" value={s.low} format={eqDb} onChange={(v) => deck.setEq('low', v)} />
          <Knob label="FILTER" value={s.filter} format={filterText} onChange={(v) => deck.setFilter(v)} />
        </div>
        <div className="fader-row">
          <Meter node={deck.meterTap} label={'Deck level ' + deck.name} />
          <Scale marks={FADER_MARKS} bare />
          <input
            className="vfader"
            type="range"
            min={0}
            max={1}
            step={0.005}
            value={s.volume}
            aria-label={'Volume deck ' + deck.name}
            onChange={(e) => deck.setVolume(Number(e.target.value))}
            onDoubleClick={() => deck.setVolume(0.8)}
          />
          <Scale marks={FADER_MARKS} className="right" bare />
        </div>
      </div>
    </div>
  )
}

/** Small mark per voice on the quick buttons (their names are in the tooltip and the Dub Box tab). */
const VOICE_MARK = { siren: '∿', noise: '≋', spring: '⌇', sample: '▸' } as const

const CURVE_LABEL = { smooth: 'SMOOTH', cut: 'CUT', thru: 'THRU' } as const
const NEXT_CURVE = { smooth: 'cut', cut: 'thru', thru: 'smooth' } as const
const CURVE_HINT = {
  smooth: 'Smooth curve: gradual transition',
  cut: 'Cut curve: each deck comes in almost at once (scratch / cuts)',
  thru: 'THRU: crossfader off, both decks pass and only the faders count',
} as const

/** 8 beats of the deck that is playing (the one leaving), else 4 seconds. */
function fadeSeconds(): number {
  const playing = [deckA.get(), deckB.get()].find((d) => d.playing && d.bpm)
  return playing?.bpm ? Math.min(12, Math.max(2, (8 * 60) / (playing.bpm * playing.rate))) : 4
}

/**
 * Crossfader with its curve switch. A and B light in the deck's colour as loud as that side is heard;
 * clicking one glides the fader there over 8 beats (click again to stop). Snaps to the middle,
 * double-click centres it, arrow keys move it.
 */
/** Crossfader curve: smooth, cut or through; a click moves to the next. */
function CurveButton() {
  const m = useStore(mixer)
  return (
    <button
      className={'xf-curve' + (m.xfCurve !== 'smooth' ? ' on' : '')}
      aria-label={'Crossfader curve: ' + CURVE_LABEL[m.xfCurve]}
      onClick={() => mixer.setCrossfaderCurve(NEXT_CURVE[m.xfCurve])}
      title={CURVE_HINT[m.xfCurve] + '. Click to change'}
    >
      <svg viewBox="0 0 20 12" width="20" height="12" aria-hidden="true">
        {m.xfCurve === 'cut' ? (
          <path d="M1 11V2h18v9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        ) : m.xfCurve === 'thru' ? (
          <path d="M1 3h18M1 9h18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        ) : (
          <path d="M1 11C5 1 15 1 19 11" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        )}
      </svg>
      <span>{CURVE_LABEL[m.xfCurve]}</span>
    </button>
  )
}

function Crossfader() {
  const m = useStore(mixer)
  const side = (n: 0 | 1) => {
    const level = mixer.sideGain(n)
    const fading = m.fading === n
    return (
      <button
        className={'xf-side ' + (n === 0 ? 'a' : 'b') + (fading ? ' fading' : '')}
        style={{ '--lit': level } as React.CSSProperties}
        aria-pressed={fading}
        onClick={() => mixer.autoFade(n, fadeSeconds())}
        title={
          fading
            ? 'Moving to deck ' + 'AB'[n] + '. Click to stop'
            : 'Move the crossfader to deck ' + 'AB'[n] + ' over 8 beats (' + fadeSeconds().toFixed(1) + ' s)'
        }
      >
        {'AB'[n]}
      </button>
    )
  }
  return (
    <div className={'xfader' + (m.xfCurve === 'thru' ? ' off' : '')}>
      {side(0)}
      <div className={'xf-track' + (m.fading !== null ? ' fading' : '')}>
        {m.xfCurve === 'thru' && (
          <button
            className="xf-off"
            onClick={() => mixer.setCrossfaderCurve('smooth')}
            title="The crossfader is off (THRU). Click to turn it on"
          >
            OFF · TURN ON
          </button>
        )}
        {/* Marks under the fader: the middle one longer. */}
        <div className="xf-marks" aria-hidden="true">
          {Array.from({ length: 9 }, (_, i) => (
            <i key={i} className={i === 4 ? 'mid' : i % 2 ? 'minor' : ''} />
          ))}
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={m.crossfader}
          aria-label="Crossfader"
          aria-valuetext={
            m.crossfader < 0.02
              ? 'A only'
              : m.crossfader > 0.98
                ? 'B only'
                : Math.abs(m.crossfader - 0.5) < 0.02
                  ? 'Meio'
                  : undefined
          }
          onChange={(e) => mixer.setCrossfader(Number(e.target.value))}
          onDoubleClick={() => mixer.setCrossfader(0.5)}
          title="Crossfader: double-click centres it. Click A or B to move it by itself"
        />
      </div>
      {side(1)}
    </div>
  )
}

/** The sampler's pads, four at a time, playable from the mixer in place of the noise slots. */
export function SoundPads({ page, setPage }: { page: number; setPage(p: number): void }) {
  const s = useStore(sampler)
  const pages = Math.ceil(s.pads.length / 4)
  return (
    <>
      <div className="dbx-slots dbx-pad-row">
        {s.pads.slice(page * 4, page * 4 + 4).map((pad, k) => {
          const i = page * 4 + k
          return (
            <button
              key={i}
              className={'dbx-slot dbx-pad' + (pad.name ? '' : ' empty') + (pad.playing ? ' on' : '')}
              onClick={() => (pad.name ? sampler.trigger(i) : ui.open('sampler'))}
              title={
                pad.name
                  ? pad.name + (pad.playing ? ': click to stop' : ': play')
                  : 'Pad ' + (i + 1) + ' empty: pick a sound in the Sampler tab'
              }
            >
              {pad.playing && <i className="dbx-pad-bar" style={{ animationDuration: pad.duration + 's' }} />}
              <b>{i + 1}</b>
              <span className="dbx-slot-name">{pad.name ?? '+ sound'}</span>
            </button>
          )
        })}
      </div>
      <button
        className="dbx-page"
        onClick={() => setPage((page + 1) % pages)}
        title={'Show pads ' + (((page + 1) % pages) * 4 + 1) + ' a ' + (((page + 1) % pages) * 4 + 4)}
        aria-label="Another page of pads"
      >
        {page * 4 + 1}–{page * 4 + 4}
        <span className="dbx-page-dots" aria-hidden="true">
          {Array.from({ length: pages }, (_, p) => (
            <i key={p} className={p === page ? 'now' : s.pads.slice(p * 4, p * 4 + 4).some((x) => x.playing) ? 'lit' : ''} />
          ))}
        </span>
      </button>
    </>
  )
}

const LS_DUB_VIEW = 'vx_dub_view'

/** Dub Box channel: the live siren / noise box, played over the music. Full settings in its own tab. */
export function DubBoxStrip() {
  const d = useStore(dubBox)
  const p = d.patch
  const [pLo, pHi] = PATCH_LIMITS.pitch
  const [rLo, rHi] = PATCH_LIMITS.lfoRate
  const [over, setOver] = useState(false)
  const anyPlaying = useStore(sampler).pads.some((p) => p.playing)
  const [view, setView] = useState<'noise' | 'sounds'>(() => {
    try {
      return localStorage.getItem(LS_DUB_VIEW) === 'sounds' ? 'sounds' : 'noise'
    } catch {
      return 'noise'
    }
  })
  const [page, setPage] = useState(0)
  const pick = (next: 'noise' | 'sounds') => {
    setView(next)
    try {
      localStorage.setItem(LS_DUB_VIEW, next)
    } catch {
      /* not remembered */
    }
  }
  const slots = (
    <div className="dbx-slots">
      {d.slots.map((slot, i) => (
        <button
          key={i}
          className={'dbx-slot' + (slot ? '' : ' empty') + (d.slotPlaying === i ? ' on' : '')}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.currentTarget.setPointerCapture(e.pointerId)
            dubBox.fireSlot(i, true)
          }}
          onPointerUp={(e) => e.button === 0 && dubBox.fireSlot(i, false)}
          onPointerCancel={() => dubBox.fireSlot(i, false)}
          onContextMenu={(e) => {
            e.preventDefault()
            dubBox.assignSlot(i)
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(DUB_PRESET_DRAG)) e.preventDefault()
          }}
          onDrop={(e) => {
            const name = e.dataTransfer.getData(DUB_PRESET_DRAG)
            if (!name) return
            e.preventDefault()
            e.stopPropagation()
            dubBox.assignSlotPreset(i, name)
          }}
          title={
            slot
              ? `${slot.name}: click to play. Right-click: save the current sound here`
              : 'Empty: click to save the current sound here, or drag a preset'
          }
        >
          {slot ? (
            <>
              <b>{i + 1}</b>
              <span className="dbx-slot-name">{slot.name}</span>
              <em aria-hidden="true">{VOICE_MARK[slot.patch.voice]}</em>
            </>
          ) : (
            <i>+{i + 1}</i>
          )}
        </button>
      ))}
    </div>
  )
  return (
    <div
      className={'dbx-strip' + (over ? ' over' : '') + (d.rehearse ? ' rehearse' : '')}
      aria-label="Dub Box"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        const file = e.dataTransfer.files[0]
        setOver(false)
        if (!file) return
        e.preventDefault()
        e.stopPropagation()
        void dubBox.loadSampleFile(file)
      }}
      title="Drop an audio file here to play it on the Dub Box"
    >
      <div className="dbx-head">
        {/* Noises (presets fired with FIRE) or sounds (the sampler's pads): same row, one click apart. */}
        <div className="dbx-view" role="group" aria-label="What the row shows">
          <button
            className={view === 'noise' ? 'now' : ''}
            aria-pressed={view === 'noise'}
            onClick={() => pick('noise')}
            title="Dub Box noises: sirens, laser, spring"
          >
            DUB
          </button>
          <button
            className={(view === 'sounds' ? 'now' : '') + (anyPlaying ? ' lit' : '')}
            aria-pressed={view === 'sounds'}
            onClick={() => pick('sounds')}
            title="Sampler sounds: jingles, shouts, effects"
          >
            SOUNDS
          </button>
        </div>
        {view === 'noise' ? (
          <>
            {slots}
            <button
              className="dbx-more"
              aria-label="Open Dub Box settings"
              title="All settings (Dub Box tab)"
              onClick={() => ui.open('dubbox')}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <circle cx="16" cy="7" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="10" cy="17" r="2" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            </button>
          </>
        ) : (
          <>
            <SoundPads page={page} setPage={setPage} />
          </>
        )}
        <button
          className={'pfl' + (d.pfl ? ' on' : '')}
          aria-pressed={d.pfl}
          aria-label="Pre-listen the Dub Box in the headphones"
          title="Pre-listen: hear the Dub Box in the headphones"
          onClick={() => dubBox.togglePfl()}
        >
          {phones}
        </button>
      </div>
      <div className="dbx-body">
        <button
          className={'dbx-fire' + (d.playing ? ' on' : '')}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dubBox.fire(true)
          }}
          onPointerUp={() => dubBox.fire(false)}
          onPointerCancel={() => dubBox.fire(false)}
          title={d.mode === 'hold' ? 'Hold: plays while pressed' : 'Latch: tap on, tap off'}
        >
          FIRE
        </button>
        <div className="dbx-sound">
          <button className="dbx-step" onClick={() => dubBox.stepPreset(-1)} aria-label="Previous sound" title="Previous sound">
            ‹
          </button>
          <DubSoundMenu />
          <button className="dbx-step" onClick={() => dubBox.stepPreset(1)} aria-label="Next sound" title="Next sound">
            ›
          </button>
        </div>
        <button
          className={'dbx-throw' + (d.throwing ? ' on' : '')}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            dubBox.throw(true)
          }}
          onPointerUp={() => dubBox.throw(false)}
          onPointerCancel={() => dubBox.throw(false)}
          title="FX: hold to throw everything into the Dub Box echo. Release: only the tail is left"
        >
          FX
        </button>
        <Knob
          label="PITCH"
          value={toLog(p.pitch, pLo, pHi)}
          min={0}
          max={1}
          reset={toLog(440, pLo, pHi)}
          format={(v) => {
            const hz = fromLog(v, pLo, pHi)
            return hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz'
          }}
          onChange={(v) => dubBox.updatePatch({ pitch: fromLog(v, pLo, pHi) })}
        />
        <Knob
          label="OSC"
          value={toLog(p.lfoRate, rLo, rHi)}
          min={0}
          max={1}
          reset={toLog(1.6, rLo, rHi)}
          format={(v) => fromLog(v, rLo, rHi).toFixed(1) + ' Hz'}
          onChange={(v) => dubBox.updatePatch({ lfoRate: fromLog(v, rLo, rHi) })}
        />
        <Knob
          label="ECHO"
          value={p.echo}
          min={0}
          max={1}
          reset={0.5}
          format={pct}
          onChange={(v) => dubBox.updatePatch({ echo: v })}
        />
        <Knob label="FILTER" value={d.filter} format={filterText} onChange={(v) => dubBox.setFilter(v)} />
        <div className="dbx-out">
          <Knob label="LEVEL" value={d.level} min={0} max={1} reset={0.8} format={pct} onChange={(v) => dubBox.setLevel(v)} />
          <Meter node={dubBox.meterTap} label="Dub Box level" />
        </div>
      </div>
    </div>
  )
}

const PAGES: { id: Centre; label: string; hint: string }[] = [
  { id: 'mixer', label: 'MIXER', hint: 'Channels, EQ and filters (in Pro also isolator, sound system, mic, transitions)' },
  { id: 'dub', label: 'DUB', hint: 'Dub Box: FIRE, its sounds, DROP' },
  { id: 'fx', label: 'FX', hint: "Each deck's effect and THROW; in Pro the two AUX effects fed by the stems" },
  { id: 'echo', label: 'DECK DUB', hint: "The echo of the decks' DUB button: presets, time, feedback, tone, hold / latch" },
  { id: 'tape', label: 'TAPE', hint: 'The tape echo on the master: throw, time, tape, spring, output' },
  { id: 'mic', label: 'MIC', hint: 'The microphone: TALK, level, duck, presets, colour, echo and spring' },
]

/**
 * The centre of the stage: one page at a time (MIXER, DUB, FX, DECK DUB, TAPE, MIC). The master output and the
 * crossfader stay on every page.
 */
export function MixerView() {
  const m = useStore(mixer)
  const centre = useStore(ui).centre
  const onMixer = centre === 'mixer'
  return (
    <section className={'mixer centre-' + centre} aria-label="Centre">
      <nav className="ctr-tabs" role="tablist" aria-label="Centre pages">
        {PAGES.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={centre === p.id}
            className={centre === p.id ? 'on' : ''}
            onClick={() => ui.setCentre(p.id)}
            title={p.hint}
          >
            {p.label}
          </button>
        ))}
      </nav>
      {onMixer && (
        <div className="strip-wrap a">
          <Strip deck={deckA} />
        </div>
      )}
      {centre === 'fx' && (
        <div className="ctr-page fx-a">
          <FxSide deck={deckA} />
        </div>
      )}

      {!onMixer && centre !== 'fx' && (
        <div className="ctr-page">{centre === 'dub' ? <DubPage /> : centre === 'echo' ? <EchoPage /> : centre === 'mic' ? <MicPage /> : <TapePage />}</div>
      )}
      <div className="mx-master">
        <section className="mx-sec mx-out" aria-label="Master output">
          <span className="ch-tag mx-brand">
            <img className="rx-logo" src={logo} alt="" aria-hidden="true" />
            MASTER
          </span>
          <VuPair />
          <div className="fader-row">
            <Meter node={mixer.masterOut} label="Master level (left and right)" stereo />
            <Scale marks={DB_MARKS} className="db" bare />
            <input
              className="vfader master-fader"
              type="range"
              min={0}
              max={1}
              step={0.005}
              value={m.master}
              aria-label="Master"
              onChange={(e) => mixer.setMaster(Number(e.target.value))}
              onDoubleClick={() => mixer.setMaster(0.8)}
            />
            <Scale marks={FADER_MARKS} className="right" bare />
          </div>
          <div
            className={'phones-knobs' + (m.hpDevice ? '' : ' bypassed')}
            title={
              m.hpDevice
                ? 'Headphones: VOL is their volume, MIX goes from the cue to the master'
                : 'Pick the headphone output in Settings › Audio'
            }
          >
            <span className="phones-cap">PHONES</span>
            <Knob
              label="VOL"
              value={m.hpVolume}
              min={0}
              max={1}
              reset={0.8}
              format={pct}
              onChange={(v) => mixer.setHeadphoneVolume(v)}
            />
            <Knob
              label="MIX"
              value={m.cueMix}
              min={0}
              max={1}
              reset={0}
              format={(v) => (v < 0.03 ? 'CUE' : v > 0.97 ? 'MASTER' : pct(1 - v) + ' cue')}
              onChange={(v) => mixer.setCueMix(v)}
            />
          </div>
        </section>
        {onMixer && (
          <div className="mx-master-side">
            <MasterIsolator />
            <SoundSystem />
            <MicSection />
          </div>
        )}
      </div>
      {centre === 'fx' && (
        <div className="ctr-page fx-b">
          <FxSide deck={deckB} />
        </div>
      )}
      {onMixer && (
        <div className="strip-wrap b">
          <Strip deck={deckB} />
        </div>
      )}
      <div className="mx-bottom">
        <div className="mx-xrow">
          <div className="mx-xrow-side">
            <CurveButton />
            <TransitionRoute />
          </div>
          <Crossfader />
          <div className="mx-xrow-side right">
            <TransitionTiming />
          </div>
        </div>
        <TransitionMoves />
      </div>
    </section>
  )
}
