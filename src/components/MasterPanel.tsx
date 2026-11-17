import { useEffect, useRef } from 'react'
import { mixer } from '../engine/mixer'
import { COMP_PRESETS, LIMITS } from '../engine/dynamics'
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
      <span>REDUÇÃO</span>
      <div className="mf-gr-track">
        <i ref={bar} />
      </div>
      <b ref={text}>0.0</b>
    </div>
  )
}

export const compGr = () => mixer.dynamics.compReduction
export const limGr = () => mixer.dynamics.limReduction

/**
 * The master's two plugins, as rack units: a compressor (with presets) to even the mix out and make it
 * fuller, and a limiter that never lets the master go over its ceiling.
 */
export function MasterPanel() {
  const d = useStore(mixer).dynamics
  const set = mixer.setDynamics.bind(mixer)
  const [aLo, aHi] = LIMITS.attack
  const [rLo, rHi] = LIMITS.release
  const [qLo, qHi] = LIMITS.ratio
  const [lrLo, lrHi] = LIMITS.limRelease

  return (
    <div className="mf2">
      <section className={'mx-sec mf2-unit' + (d.comp ? ' on' : '')} aria-label="Compressor do master">
        <header className="mf2-head">
          <button
            className={'mx-dyn-btn mf2-power' + (d.comp ? ' on' : '')}
            aria-pressed={d.comp}
            onClick={() => set({ comp: !d.comp })}
            title="Compressor: mistura mais cheia e constante. Ajusta o ganho até a redução andar pelos 2 a 6 dB"
          >
            <i className={'mx-gr' + (d.comp ? '' : ' off')} aria-hidden="true" />
            COMPRESSOR
          </button>
          <div className="mf2-presets" role="group" aria-label="Predefinições do compressor">
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
            label="LIMIAR"
            value={d.threshold}
            min={LIMITS.threshold[0]}
            max={LIMITS.threshold[1]}
            reset={-18}
            format={dB}
            onChange={(v) => set({ threshold: v })}
          />
          <Knob
            label="RÁCIO"
            value={toLog(d.ratio, qLo, qHi)}
            min={0}
            max={1}
            reset={toLog(2, qLo, qHi)}
            format={(t) => fromLog(t, qLo, qHi).toFixed(1) + ':1'}
            onChange={(t) => set({ ratio: fromLog(t, qLo, qHi) })}
          />
          <Knob
            label="ATAQUE"
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
          <Knob
            label="GANHO"
            value={d.makeup}
            min={LIMITS.makeup[0]}
            max={LIMITS.makeup[1]}
            reset={2}
            format={dB}
            onChange={(v) => set({ makeup: v })}
          />
          <div className="mf2-read">
            <span>
              {d.threshold.toFixed(0)} dB · {d.ratio.toFixed(1)}:1 · +{d.makeup.toFixed(1)} dB
            </span>
            {d.comp ? <Reduction read={compGr} label="Redução do compressor" /> : <em>Desligado: o som passa sem mexer</em>}
          </div>
        </div>
      </section>

      <section className={'mx-sec mf2-unit lim' + (d.lim ? ' on' : '')} aria-label="Limiter do master">
        <header className="mf2-head">
          <button
            className={'mx-dyn-btn mf2-power' + (d.lim ? ' on' : '')}
            aria-pressed={d.lim}
            onClick={() => set({ lim: !d.lim })}
            title="Limiter: nada passa do teto. Se a redução ficar sempre acima de 3 dB, baixa o master"
          >
            <i className={'mx-gr' + (d.lim ? '' : ' off')} aria-hidden="true" />
            LIMITER
          </button>
          <span className="mf2-sub">nunca passa do teto</span>
        </header>
        <div className="mf2-body">
          <Knob
            label="TETO"
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
            <span>Teto {d.ceiling.toFixed(1)} dB</span>
            {d.lim ? <Reduction read={limGr} label="Redução do limiter" /> : <em>Desligado: os picos podem distorcer</em>}
          </div>
        </div>
      </section>
    </div>
  )
}
