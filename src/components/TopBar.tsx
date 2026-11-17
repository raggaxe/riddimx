import { useEffect, useRef, useState } from 'react'
import { mixer } from '../engine/mixer'
import { deckA, deckB } from '../engine/deck'
import { dubBox } from '../engine/dubbox'
import { bpmStore } from '../engine/bpm'
import { library } from '../library'
import { lyrics } from '../engine/lyrics'
import logo from '../assets/riddimx-x.svg'
import { useStore } from '../store'

/** Master level, left over right, as two thin horizontal bars. */
function MasterMeter() {
  const bars = useRef<(HTMLElement | null)[]>([])
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctx = mixer.ctx
    const split = ctx.createChannelSplitter(2)
    mixer.masterOut.connect(split)
    const analysers = [0, 1].map((i) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      split.connect(a, i)
      return a
    })
    const data = new Float32Array(1024)
    const level = [0, 0]
    let hotUntil = 0
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = performance.now()
      analysers.forEach((a, i) => {
        a.getFloatTimeDomainData(data)
        let peak = 0
        for (let k = 0; k < data.length; k++) peak = Math.max(peak, Math.abs(data[k]))
        if (peak >= 0.98) hotUntil = now + 900
        const target = peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 48) / 48)) : 0
        level[i] = target > level[i] ? target : level[i] * 0.93
        const bar = bars.current[i]
        if (bar) bar.style.transform = `scaleX(${level[i]})`
      })
      box.current?.classList.toggle('clip', now < hotUntil)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      mixer.masterOut.disconnect(split)
      split.disconnect()
    }
  }, [])

  return (
    <div className="tb-meter" ref={box} role="img" aria-label="Nível do master">
      {[0, 1].map((i) => (
        <span key={i}>
          <i ref={(el) => (bars.current[i] = el)} />
        </span>
      ))}
    </div>
  )
}

/**
 * "Too hot" warning that says where the excess comes from: lit while the limiter has to pull the
 * master down hard (or the master clips with it off), naming the loudest source at that moment.
 */
function HotSource() {
  const label = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const ctx = mixer.ctx
    const sources = [
      { name: 'deck A', node: deckA.meterTap },
      { name: 'deck B', node: deckB.meterTap },
      { name: 'Dub Box', node: dubBox.meterTap },
    ].map((s) => {
      const a = ctx.createAnalyser()
      a.fftSize = 1024
      s.node.connect(a)
      return { ...s, a }
    })
    const out = ctx.createAnalyser()
    out.fftSize = 1024
    mixer.masterOut.connect(out)
    const buf = new Float32Array(1024)
    const peak = (a: AnalyserNode) => {
      a.getFloatTimeDomainData(buf)
      let p = 0
      for (const v of buf) p = Math.max(p, Math.abs(v))
      return p
    }
    let until = 0
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const now = performance.now()
      const hot = mixer.dynamics.limReduction < -3 || peak(out) > 0.98
      if (hot) {
        const loudest = sources.map((s) => ({ name: s.name, p: peak(s.a) })).sort((x, y) => y.p - x.p)[0]
        if (label.current) label.current.textContent = 'QUENTE · ' + loudest.name
        until = now + 1200
      }
      label.current?.classList.toggle('on', now < until)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      for (const s of sources) s.node.disconnect(s.a)
      mixer.masterOut.disconnect(out)
    }
  }, [])
  return (
    <span
      ref={label}
      className="tb-hot"
      role="status"
      title="Acende quando a pista está alta demais (o limiter trabalha muito): baixa o ganho ou o fader dessa fonte"
    />
  )
}

/** Wall clock: DJs play to the hour. */
function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 10_000)
    return () => window.clearInterval(timer)
  }, [])
  return (
    <time className="tb-clock" dateTime={now.toISOString()} title="Hora">
      {now.getHours()}:{String(now.getMinutes()).padStart(2, '0')}
    </time>
  )
}

/**
 * Top bar: name on the left, what the app is busy with in the middle (only while it is busy),
 * clock, master level and recording on the right.
 */
export function TopBar() {
  const mix = useStore(mixer)
  const bpm = useStore(bpmStore)
  const lib = useStore(library)
  const a = useStore(deckA)
  const b = useStore(deckB)
  const lyr = useStore(lyrics)
  const [, tick] = useState(0)

  useEffect(() => {
    if (!mix.recording) return
    const timer = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(timer)
  }, [mix.recording])
  const recorded = mix.recording ? Math.floor((performance.now() - mix.recordedAt) / 1000) : 0

  const busy: string[] = []
  ;[a, b].forEach((s, i) => {
    if (s.aiStems === 'working') busy.push('Stems ' + 'AB'[i] + ' ' + Math.round(s.aiProgress * 100) + '%')
  })
  for (const [name, p] of Object.entries(lyr.working)) busy.push('Letra ' + name + ' ' + Math.round(p * 100) + '%')
  if (lib.analyzing) busy.push('A medir BPM e tom')
  if (bpm.looking.length) busy.push('A procurar BPM de ' + bpm.looking.length)

  return (
    <header className="topbar">
      {/* The painted X is the logo and the last letter of the name at once. */}
      <h1 aria-label="RiddimX">
        <b className="rx-name" aria-hidden="true">
          Riddim
          <img className="rx-x" src={logo} alt="" />
        </b>
      </h1>
      {/* What is on the decks, at a glance: track, tempo as played, and how far apart the two tempos are. */}
      <div className="tb-decks" aria-label="Decks">
        {[a, b].map((d, i) =>
          d.kind === 'none' ? null : (
            <span key={i} className={'tb-deck ' + 'ab'[i] + (d.playing ? ' playing' : '')}>
              <b>{'AB'[i]}</b>
              <i aria-label={d.playing ? 'a tocar' : 'parado'} />
              <em>{d.title}</em>
              {d.bpm ? <strong>{(d.bpm * d.rate).toFixed(1)}</strong> : null}
            </span>
          ),
        )}
        {a.bpm && b.bpm && a.kind !== 'none' && b.kind !== 'none' && (
          <span
            className={'tb-delta' + (Math.abs(a.bpm * a.rate - b.bpm * b.rate) < 0.05 ? ' locked' : '')}
            title="Diferença de tempo entre os dois decks (0.0 = em sincronia)"
          >
            Δ {Math.abs(a.bpm * a.rate - b.bpm * b.rate).toFixed(1)}
          </span>
        )}
      </div>
      <div className="tb-status" aria-live="polite">
        {busy.map((text) => (
          <span key={text} className="tb-busy">
            <i aria-hidden="true" />
            {text}
          </span>
        ))}
      </div>
      <div className="top-actions">
        <Clock />
        <HotSource />
        <MasterMeter />
        <button
          className={'rec' + (mix.recording ? ' on' : '')}
          aria-pressed={mix.recording}
          onClick={() => mixer.toggleRecording()}
          title={mix.recording ? 'Parar e guardar a gravação' : 'Gravar a mistura'}
        >
          <i />
          {mix.recording ? Math.floor(recorded / 60) + ':' + String(recorded % 60).padStart(2, '0') : 'REC'}
        </button>
      </div>
    </header>
  )
}
