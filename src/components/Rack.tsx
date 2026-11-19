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

/** Auto dub in the rack: hidden for now, kept on the roadmap. */
const AUTO_DUB_ON = false

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
      outboard.throwPress(deck, true)
    },
    onPointerUp: () => outboard.throwPress(deck, false),
    onPointerCancel: () => outboard.throwPress(deck, false),
  })
  const manual = o.timeMode === 'manual'
  return (
    <div className="echo-desk">
      <MixSection title="Throw" className="echo-throw">
        <div className="echo-throws">
          {(['A', 'B'] as const).map((d) => (
            <button
              key={d}
              className={'ru-throw ' + d.toLowerCase() + (o.throwing[d] ? ' on' : '')}
              {...hold(d)}
              title={
                o.throwMode === 'bar'
                  ? 'Press: deck ' + d + ' drops out, its last beat rings in the echo, the music is back on the one of the next bar. Press again: back now'
                  : 'Hold: deck ' + d + ' goes into the echo; let go and the repeats carry on'
              }
            >
              THROW {d}
            </button>
          ))}
        </div>
        <div className="seg echo-mode" role="radiogroup" aria-label="THROW mode">
          <button
            role="radio"
            aria-checked={o.throwMode === 'bar'}
            className={o.throwMode === 'bar' ? 'on' : ''}
            onClick={() => outboard.setThrowMode('bar')}
            title="One press: the music stops, the echo rings, the music returns on the next bar"
          >
            TO BAR
          </button>
          <button
            role="radio"
            aria-checked={o.throwMode === 'hold'}
            className={o.throwMode === 'hold' ? 'on' : ''}
            onClick={() => outboard.setThrowMode('hold')}
            title="Works while held; the music keeps playing under the echo"
          >
            HOLD
          </button>
        </div>
        <Knob label="SEND A" value={o.send.A} min={0} max={1} reset={0} format={pct} onChange={(v) => outboard.setSend('A', v)} />
        <Knob label="SEND B" value={o.send.B} min={0} max={1} reset={0} format={pct} onChange={(v) => outboard.setSend('B', v)} />
      </MixSection>
      <MixSection title={manual ? 'Time · by hand' : 'Time · follows the music'} className="echo-time">
        <select
          className="ru-select"
          value={o.division}
          aria-label="Echo time"
          title="Echo time from the beat of the music"
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
          title="Tap 2 or more times at the tempo you want. Double-click: follow the music again"
        >
          TAP · {Math.round(outboard.echoTime * 1000)} ms
        </button>
        <Knob
          label="TIME"
          value={outboard.echoTime}
          min={0.05}
          max={2}
          reset={0.375}
          format={(v) => Math.round(v * 1000) + ' ms'}
          onChange={(v) => outboard.setManualTime(v)}
        />
      </MixSection>
      <MixSection title="Tape" className="echo-tape">
        <Knob
          label="FEEDBACK"
          value={o.feedback}
          min={0}
          max={1.1}
          reset={0.55}
          format={(v) => (v > 1 ? 'RUNAWAY ' : '') + Math.round(v * 100) + '%'}
          onChange={(v) => outboard.update({ feedback: v })}
        />
        <Knob
          label="TONE"
          value={o.tone}
          min={0}
          max={1}
          reset={0.45}
          format={(v) => (v < 0.35 ? 'dark' : v > 0.7 ? 'bright' : 'tape')}
          onChange={(v) => outboard.update({ tone: v })}
        />
        <Knob
          label="WEAR"
          value={o.wobble}
          min={0}
          max={1}
          reset={0.35}
          format={pct}
          onChange={(v) => outboard.update({ wobble: v })}
        />
      </MixSection>
      <MixSection title="Spring" className="echo-spring">
        <Knob label="SPRING" value={o.spring} min={0} max={1} reset={0.4} format={pct} onChange={(v) => outboard.update({ spring: v })} />
        <button className="ru-crash" onClick={() => outboard.crash()} title="Kick the spring: the crash of the spring reverb">
          KICK
        </button>
      </MixSection>
      <MixSection title="Output" className="echo-out">
        <Knob
          label="LEVEL"
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
            ? 'Stop: the music goes back to how it was'
            : ready
              ? 'On: the app makes a live dub version of deck ' + live!.name + ''
              : 'Get a track (file) playing first'
        }
      >
        <b>{ad.on ? 'STOP' : 'AUTO'}</b>
        <span>{target ? 'deck ' + target : '—'}</span>
      </button>
      <div className="ru-seg" role="group" aria-label="Intensity">
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
        <b>{ad.on ? ad.scene : ready ? 'Ready' : 'Waiting'}</b>
        <span>
          {ad.on
            ? (ad.doing ?? (ad.grid ? 'changes at the start of each phrase' : 'no beat grid: follows the tempo'))
            : ready
              ? 'press AUTO to start'
              : 'play a track'}
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
      <span className="rack-tag" title="Dub effects for the whole mix: not one deck's">DUB FX</span>
      <section className="dub-area" aria-label="Dub">
        <button className="dub-badge" onClick={() => ui.open('dubbox')} title="Dub: all settings in the Dub Box tab, below">
          <DubMark />
          <span>DUB</span>
        </button>
        <div className="dub-part dub-box">
          <DubBoxStrip />
        </div>
        {/* Auto dub is parked for now (on the roadmap): the Dub Box takes the whole row. */}
        {AUTO_DUB_ON && (
          <>
            <i className="dub-sep" aria-hidden="true" />
            <div className="dub-part dub-auto" role="group" aria-label="Auto dub">
              <AutoDubControls />
            </div>
          </>
        )}
      </section>
    </div>
  )
}
