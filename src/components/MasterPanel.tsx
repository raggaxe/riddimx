import { useEffect, useRef, useState } from 'react'
import { mixer } from '../engine/mixer'
import { COMP_PRESETS, LIMITS } from '../engine/dynamics'
import { deckA, deckB } from '../engine/deck'
import { LUFS_TARGET } from '../engine/loudness'
import { useStore } from '../store'
import { Knob } from './Knob'

/** Value ↔ 0..1 on a log scale, for times and ratios (fine control where it matters). */
const toLog = (v: number, lo: number, hi: number) => Math.log(v / lo) / Math.log(hi / lo)
const fromLog = (t: number, lo: number, hi: number) => lo * Math.pow(hi / lo, t)
const ms = (s: number) => (s < 0.01 ? (s * 1000).toFixed(1) : Math.round(s * 1000)) + ' ms'
const dB = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB'

/** How much a stage is pulling the level down right now: a bar growing from the right, 0 to -12 dB. */
export function Reduction({ read, label }: { read: () => number; label: string }) {
  const bar = useRef<HTMLElement>(null)
  const text = useRef<HTMLElement>(null)
  useEffect(() => {
    let raf = 0
    let shown = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const r = Math.min(0, read())
      shown = r < shown ? r : shown * 0.85 + r * 0.15
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, -shown / 12)})`
      if (text.current) text.current.textContent = shown > -0.05 ? '0.0' : shown.toFixed(1)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [read])
  return (
    <div className="mf-gr" role="img" aria-label={label}>
      <span>GR</span>
      <div className="mf-gr-track">
        <i ref={bar} />
      </div>
      <b ref={text}>0.0</b>
    </div>
  )
}

/** The make-up gain auto mode is using, read a few times a second while it runs. */
function useAutoGain(on: boolean): number {
  const [gain, setGain] = useState(mixer.dynamics.autoMakeup)
  useEffect(() => {
    if (!on) return
    const t = window.setInterval(() => setGain(Math.round(mixer.dynamics.autoMakeup * 10) / 10), 250)
    return () => window.clearInterval(t)
  }, [on])
  return gain
}

export const compGr = () => mixer.dynamics.compReduction
export const limGr = () => mixer.dynamics.limReduction

/**
 * The master's two plugins, as rack units: a compressor (with presets) to even the mix out and make it
 * fuller, and a limiter that never lets the master go over its ceiling.
 */
/** Loudness match: every file track at the same loudness (LUFS), whatever level it was mastered at. */
function LoudnessUnit() {
  const on = useStore(mixer).loudMatch
  const a = useStore(deckA)
  const b = useStore(deckB)
  const row = (name: string, s: typeof a, match: number) => (
    <span key={name}>
      {name}{' '}
      {s.kind === 'none'
        ? '—'
        : s.lufs === null
          ? s.kind === 'local'
            ? 'measuring…'
            : 'not measurable (stream)'
          : s.lufs.toFixed(1) + ' LUFS' + (on ? ' → ' + (match > 0 ? '+' : '') + match.toFixed(1) + ' dB' : '')}
    </span>
  )
  return (
    <section className={'mx-sec mf2-unit' + (on ? ' on' : '')} aria-label="Loudness match">
      <header className="mf2-head">
        <button
          className={'mx-dyn-btn mf2-power' + (on ? ' on' : '')}
          aria-pressed={on}
          onClick={() => mixer.setLoudMatch(!on)}
          title={'Every track is measured (LUFS) as it loads and brought to ' + LUFS_TARGET + ' LUFS on its deck, so the next tune is never louder or quieter than the last. GAIN still trims on top.'}
        >
          <i className={'mx-gr' + (on ? '' : ' off')} aria-hidden="true" />
          LOUDNESS MATCH
        </button>
        <span className="mf2-sub">target {LUFS_TARGET} LUFS</span>
      </header>
      <div className="mf2-read mf2-lufs">
        {row('A', a, deckA.matchDb)}
        {row('B', b, deckB.matchDb)}
      </div>
    </section>
  )
}

export function MasterPanel() {
  const d = useStore(mixer).dynamics
  const set = mixer.setDynamics.bind(mixer)
  const [aLo, aHi] = LIMITS.attack
  const [rLo, rHi] = LIMITS.release
  const [qLo, qHi] = LIMITS.ratio
  const [lrLo, lrHi] = LIMITS.limRelease
  const autoGain = useAutoGain(d.comp && d.autoGain)

  return (
    <div className="mf2">
      <LoudnessUnit />
      <section className={'mx-sec mf2-unit' + (d.comp ? ' on' : '')} aria-label="Master compressor">
        <header className="mf2-head">
          <button
            className={'mx-dyn-btn mf2-power' + (d.comp ? ' on' : '')}
            aria-pressed={d.comp}
            onClick={() => set({ comp: !d.comp })}
            title="Compressor: a fuller, steadier mix. Aim for 2 to 6 dB of gain reduction"
          >
            <i className={'mx-gr' + (d.comp ? '' : ' off')} aria-hidden="true" />
            COMPRESSOR
          </button>
          <div className="mf2-presets" role="group" aria-label="Compressor presets">
            {COMP_PRESETS.map((p) => (
              <button
                key={p.name}
                className={d.preset === p.name ? 'now' : ''}
                aria-pressed={d.preset === p.name}
                title={p.hint}
                onClick={() => set({ ...p.set, preset: p.name, comp: true })}
              >
                {p.name}
              </button>
            ))}
          </div>
        </header>
        <div className="mf2-body">
          <Knob
            label="THRESH"
            value={d.threshold}
            min={LIMITS.threshold[0]}
            max={LIMITS.threshold[1]}
            reset={-18}
            format={dB}
            onChange={(v) => set({ threshold: v })}
          />
          <Knob
            label="RATIO"
            value={toLog(d.ratio, qLo, qHi)}
            min={0}
            max={1}
            reset={toLog(2, qLo, qHi)}
            format={(t) => fromLog(t, qLo, qHi).toFixed(1) + ':1'}
            onChange={(t) => set({ ratio: fromLog(t, qLo, qHi) })}
          />
          <Knob
            label="ATTACK"
            value={toLog(d.attack, aLo, aHi)}
            min={0}
            max={1}
            reset={toLog(0.03, aLo, aHi)}
            format={(t) => ms(fromLog(t, aLo, aHi))}
            onChange={(t) => set({ attack: fromLog(t, aLo, aHi) })}
          />
          <Knob
            label="RELEASE"
            value={toLog(d.release, rLo, rHi)}
            min={0}
            max={1}
            reset={toLog(0.25, rLo, rHi)}
            format={(t) => ms(fromLog(t, rLo, rHi))}
            onChange={(t) => set({ release: fromLog(t, rLo, rHi) })}
          />
          <div className="mf2-gain">
            <Knob
              label={d.autoGain ? 'GAIN · AUTO' : 'GAIN'}
              value={d.autoGain ? autoGain : d.makeup}
              min={LIMITS.makeup[0]}
              max={LIMITS.makeup[1]}
              reset={2}
              format={dB}
              onChange={(v) => set({ makeup: v, autoGain: false })}
            />
            <button
              className={'mx-dyn-btn mf2-auto' + (d.autoGain ? ' on' : '')}
              aria-pressed={d.autoGain}
              onClick={() => set({ autoGain: !d.autoGain, makeup: d.autoGain ? Math.round(autoGain * 10) / 10 : d.makeup })}
              title="Auto make-up: the compressed mix stays as loud as it came in, so switching presets (Soft → Radio) never jumps in volume. Turning GAIN by hand switches it off"
            >
              AUTO
            </button>
          </div>
          <div className="mf2-read">
            <span>
              {d.threshold.toFixed(0)} dB · {d.ratio.toFixed(1)}:1 · {dB(d.autoGain ? autoGain : d.makeup)}
              {d.autoGain ? ' auto' : ''}
            </span>
            {d.comp ? <Reduction read={compGr} label="Compressor gain reduction" /> : <em>Off: the sound passes untouched</em>}
          </div>
        </div>
      </section>

      <section className={'mx-sec mf2-unit lim' + (d.lim ? ' on' : '')} aria-label="Master limiter">
        <header className="mf2-head">
          <button
            className={'mx-dyn-btn mf2-power' + (d.lim ? ' on' : '')}
            aria-pressed={d.lim}
            onClick={() => set({ lim: !d.lim })}
            title="Limiter: nothing goes over the ceiling. If it keeps reducing more than 3 dB, turn the master down"
          >
            <i className={'mx-gr' + (d.lim ? '' : ' off')} aria-hidden="true" />
            LIMITER
          </button>
          <span className="mf2-sub">never over the ceiling</span>
        </header>
        <div className="mf2-body">
          <Knob
            label="CEILING"
            value={d.ceiling}
            min={LIMITS.ceiling[0]}
            max={LIMITS.ceiling[1]}
            reset={-1}
            format={dB}
            onChange={(v) => set({ ceiling: v })}
          />
          <Knob
            label="RELEASE"
            value={toLog(d.limRelease, lrLo, lrHi)}
            min={0}
            max={1}
            reset={toLog(0.08, lrLo, lrHi)}
            format={(t) => ms(fromLog(t, lrLo, lrHi))}
            onChange={(t) => set({ limRelease: fromLog(t, lrLo, lrHi) })}
          />
          <div className="mf2-read">
            <span>Ceiling {d.ceiling.toFixed(1)} dB</span>
            {d.lim ? <Reduction read={limGr} label="Limiter gain reduction" /> : <em>Off: peaks may distort</em>}
          </div>
        </div>
      </section>
    </div>
  )
}
