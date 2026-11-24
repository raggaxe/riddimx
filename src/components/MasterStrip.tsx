import { useEffect, useRef, type ReactNode } from 'react'
import { mixer } from '../engine/mixer'
import { isolator } from '../engine/isolator'
import { outboard } from '../engine/outboard'
import { mic } from '../engine/mic'
import { useStore } from '../store'
import { ui } from '../ui'
import { Knob } from './Knob'
import { compGr, limGr } from './MasterPanel'

/**
 * The master section of the mixer, the way a sound system desk has it: VU needles on top, the
 * isolator (bass / mid / top with KILL) beside the fader, then the sound system column — PESO (sub),
 * DROP, and the COMP / LIM switches with their reduction lights. Settings that are set once and
 * left alone (band splits, PESO frequency, compressor preset, limiter ceiling) open with a right click.
 */

const hzText = (hz: number) => (hz >= 1000 ? (hz / 1000).toFixed(1) + ' kHz' : Math.round(hz) + ' Hz')
/** dB of an isolator band level (0..1.5), −∞ when off. */
const bandDb = (v: number) => (v < 0.02 ? '−∞' : (20 * Math.log10(v) > 0 ? '+' : '') + (20 * Math.log10(v)).toFixed(1) + ' dB')

/**
 * One titled area of the master: its name on top, the controls under it, and "⋯" (or a right click)
 * for the settings that are set once and left alone.
 */
export function MixSection({
  title,
  className = '',
  more,
  moreLabel,
  children,
}: {
  title: string
  className?: string
  more?: (e: React.MouseEvent) => void
  moreLabel?: string
  children: ReactNode
}) {
  return (
    <section className={'mx-sec ' + className} aria-label={title}>
      <header className="mx-sec-head">
        <span>{title}</span>
        {more && (
          <button className="mx-sec-more" aria-label={moreLabel} title={moreLabel} onClick={more}>
            ⋯
          </button>
        )}
      </header>
      <div className="mx-sec-body">{children}</div>
    </section>
  )
}

/** Bass, mid and top of the whole dance, each with a KILL; then where the bands split. */
export function MasterIsolator() {
  const i = useStore(isolator)
  const bands = [
    { key: 'low', label: 'LOW', kill: i.killLow },
    { key: 'mid', label: 'MID', kill: i.killMid },
    { key: 'top', label: 'HIGH', kill: i.killTop },
  ] as const
  return (
    <MixSection title="Isolator" className="mx-iso bus">
      {bands.map((b) => (
        <div key={b.key} className={'mx-iso-band' + (b.kill ? ' killed' : '')}>
          <Knob
            label={b.label}
            value={i[b.key]}
            min={0}
            max={1.5}
            reset={1}
            format={bandDb}
            onChange={(v) => isolator.update({ [b.key]: v })}
          />
          <button
            className={'mx-kill' + (b.kill ? ' on' : '')}
            aria-pressed={b.kill}
            onClick={() => isolator.kill(b.key, !b.kill)}
            title={'KILL: cuts the ' + b.label.toLowerCase() + ' of the whole mix (press again to bring back)'}
          >
            KILL
          </button>
        </div>
      ))}
      <i className="mx-div" aria-hidden="true" />
      <div className="mx-cuts" title="Where the lows end and the highs begin">
        <Knob
          label="CUT ↓"
          value={i.lowHz}
          min={60}
          max={400}
          reset={200}
          format={hzText}
          onChange={(v) => isolator.update({ lowHz: v })}
        />
        <Knob
          label="CUT ↑"
          value={i.highHz}
          min={1500}
          max={8000}
          reset={3000}
          format={hzText}
          onChange={(v) => isolator.update({ highHz: v })}
        />
      </div>
    </MixSection>
  )
}

/** VU angle (degrees) for a level in VU, the needle sweeping -20 … +3 VU over 96°. */
const vuAngle = (vu: number) => -48 + (Math.min(3, Math.max(-20, vu)) + 20) * (96 / 23)

/** Arc of the red zone, from `from` to `to` VU. */
function arcPath(from: number, to: number): string {
  const p = (m: number) => {
    const a = (vuAngle(m) * Math.PI) / 180
    return [40 + 34 * Math.sin(a), 46 - 34 * Math.cos(a)]
  }
  const [x1, y1] = p(from)
  const [x2, y2] = p(to)
  return `M${x1} ${y1}A34 34 0 0 1 ${x2} ${y2}`
}

/** Two needle VU meters, left and right, of the sound leaving the master; the red light is the peak. */
export function VuPair() {
  const needles = useRef<(SVGLineElement | null)[]>([])
  const peak = useRef<HTMLElement>(null)
  useEffect(() => {
    const ctx = mixer.ctx
    const split = ctx.createChannelSplitter(2)
    mixer.masterOut.connect(split)
    const an = [0, 1].map((i) => {
      const a = ctx.createAnalyser()
      a.fftSize = 2048
      split.connect(a, i)
      return a
    })
    const buf = new Float32Array(2048)
    const angle = [-48, -48]
    let raf = 0
    let hot = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      an.forEach((a, i) => {
        a.getFloatTimeDomainData(buf)
        let sum = 0
        let top = 0
        for (let k = 0; k < buf.length; k++) {
          sum += buf[k] * buf[k]
          top = Math.max(top, Math.abs(buf[k]))
        }
        if (top > 0.89) hot = performance.now() + 600
        const vu = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9) + 18 // dB relative to 0 VU
        angle[i] += (vuAngle(vu) - angle[i]) * 0.12 // needle ballistics, about 300 ms
        needles.current[i]?.setAttribute('transform', `rotate(${angle[i]} 40 46)`)
      })
      peak.current?.classList.toggle('on', performance.now() < hot)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      mixer.masterOut.disconnect(split)
      split.disconnect()
    }
  }, [])
  const marks = [-20, -10, -7, -5, -3, -1, 0, 1, 2, 3]
  return (
    <div className="mx-vu" title="Master level, left and right. The red light comes on near the limit">
      {['L', 'R'].map((side, i) => (
        <svg key={side} viewBox="0 0 80 50" className="vu-face" role="img" aria-label={'VU ' + side}>
          <defs>
            {/* A faint warm glow from under the needle, like a dimmed lamp behind the scale. */}
            <radialGradient id={'vu-glow-' + side} cx="50%" cy="100%" r="80%">
              <stop offset="0%" stopColor="#f5a524" stopOpacity="0.16" />
              <stop offset="100%" stopColor="#f5a524" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="80" height="50" rx="1.5" className="vu-bg" />
          <rect x="1" y="1" width="78" height="48" rx="1" fill={'url(#vu-glow-' + side + ')'} />
          {marks.map((m) => {
            const a = (vuAngle(m) * Math.PI) / 180
            const r2 = m === 0 || m === -20 || m === 3 ? 28 : 31
            return (
              <line
                key={m}
                x1={40 + 34 * Math.sin(a)}
                y1={46 - 34 * Math.cos(a)}
                x2={40 + r2 * Math.sin(a)}
                y2={46 - r2 * Math.cos(a)}
                className={m > 0 ? 'vu-red' : 'vu-mark'}
              />
            )
          })}
          <path d={arcPath(0, 3)} className="vu-redarc" />
          <text x="7" y="15" className="vu-txt">
            {side}
          </text>
          <line
            ref={(el) => (needles.current[i] = el)}
            x1="40"
            y1="46"
            x2="40"
            y2="10"
            className="vu-needle"
            transform="rotate(-48 40 46)"
          />
          <circle cx="40" cy="46" r="3" className="vu-hub" />
        </svg>
      ))}
      <i ref={peak} className="vu-peak" aria-hidden="true" />
    </div>
  )
}

/** Light of a dynamics switch: brighter the more it is pressing the sound down. */
function GrLight({ read }: { read: () => number }) {
  const dot = useRef<HTMLElement>(null)
  useEffect(() => {
    let raf = 0
    let shown = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const r = -Math.min(0, read())
      shown = r > shown ? r : shown * 0.9 + r * 0.1
      dot.current?.style.setProperty('opacity', String(Math.min(1, 0.25 + shown / 6)))
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [read])
  return <i ref={dot} className="mx-gr" aria-hidden="true" />
}

/** Sound system: PESO (sub) with its frequency, DROP, and the COMP and LIM switches. "⋯": the Master tab. */
export function SoundSystem() {
  const o = useStore(outboard)
  const d = useStore(mixer).dynamics
  const set = mixer.setDynamics.bind(mixer)
  return (
    <MixSection
      title="Sound system"
      className="mx-ss bus"
      more={() => ui.open('master')}
      moreLabel="Compressor and limiter in detail (Master tab, below)"
    >
      <Knob
        label="WEIGHT"
        value={o.weight}
        min={0}
        max={1}
        reset={0.3}
        format={(v) => '+' + (v * 9).toFixed(1) + ' dB'}
        onChange={(v) => outboard.update({ weight: v })}
      />
      <Knob
        label="FREQ"
        value={o.weightHz}
        min={40}
        max={120}
        reset={60}
        format={(v) => Math.round(v) + ' Hz'}
        onChange={(v) => outboard.update({ weightHz: v })}
      />
      <button
        className={'mx-drop' + (o.dropping ? ' on' : '')}
        onClick={() => outboard.drop()}
        title="DROP: takes the bass out for a bar and brings it back on the one"
      >
        DROP
      </button>
      <div className="mx-dyn">
        <button
          className={'mx-dyn-btn' + (d.comp ? ' on' : '')}
          aria-pressed={d.comp}
          onClick={() => set({ comp: !d.comp })}
          title="COMP: a fuller, steadier mix (the light shows how much it squeezes)"
        >
          {d.comp ? <GrLight read={compGr} /> : <i className="mx-gr off" aria-hidden="true" />}
          COMP
        </button>
        <button
          className={'mx-dyn-btn' + (d.lim ? ' on' : '')}
          aria-pressed={d.lim}
          onClick={() => set({ lim: !d.lim })}
          title="LIM: the master never goes over the ceiling (the light shows when it holds)"
        >
          {d.lim ? <GrLight read={limGr} /> : <i className="mx-gr off" aria-hidden="true" />}
          LIM
        </button>
      </div>
    </MixSection>
  )
}

const pct = (v: number) => Math.round(v * 100) + '%'

/**
 * The MC's microphone: FALAR opens it to the dance (the music dips while someone speaks), then the
 * voice level, its echo and spring, and how much the music dips.
 */
export function MicSection() {
  const m = useStore(mic)
  return (
    <MixSection title={m.source === 'phone' ? 'Mic input · phone' : 'Mic input'} className="mx-mic" more={() => ui.open('voice')} moreLabel="All mic effects (Mic tab)">
      <button
        className={'mx-talk' + (m.talk ? ' on' : '') + (m.speaking ? ' speaking' : '') + (m.error ? ' err' : '')}
        aria-pressed={m.talk}
        onClick={() => {
          // After a "no" from the Mac, the button leads to where it is fixed; then it tries again.
          if (m.error && /Privacidade/.test(m.error)) mic.openSettings()
          mic.setTalk(!m.talk)
        }}
        title={m.error ?? (m.talk ? 'Close the mic' : 'Open the mic to the floor (the first time the Mac asks for permission)')}
      >
        <i aria-hidden="true" />
        {m.talk ? 'ON AIR' : m.error ? 'NO MIC' : 'TALK'}
      </button>
      <Knob label="LEVEL" value={m.level} min={0} max={1.5} reset={1} format={pct} onChange={(v) => mic.update({ level: v })} />
      <Knob label="ECHO" value={m.echo} min={0} max={1} reset={0.4} format={pct} onChange={(v) => mic.update({ echo: v })} />
      <Knob label="SPRING" value={m.spring} min={0} max={1} reset={0.25} format={pct} onChange={(v) => mic.update({ spring: v })} />
      <Knob
        label="DUCK"
        value={m.duck}
        min={0}
        max={1}
        reset={0.5}
        format={(v) => (v < 0.02 ? 'never' : '−' + Math.round(-20 * Math.log10(1 - v * 0.75)) + ' dB')}
        onChange={(v) => mic.update({ duck: v })}
      />
    </MixSection>
  )
}
