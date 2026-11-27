import { useEffect, useRef, useState } from 'react'
import { BeatCounter } from './BeatCounter'
import { settings } from '../settings'
import { ui } from '../ui'
import { updateText, updates } from '../updates'
import { mixer } from '../engine/mixer'
import { deckA, deckB } from '../engine/deck'
import { dubBox } from '../engine/dubbox'
import { bpmStore } from '../engine/bpm'
import { library } from '../library'
import { lyrics } from '../engine/lyrics'
import logo from '../assets/riddimx-x.svg'
import { useStore } from '../store'
import { ClockAndSet, SetWidget } from './SetTimer'
import { NotesButton } from './NotesPanel'
import { panic } from '../panic'
import { LiveBar } from './LiveBar'

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
    <div className="tb-meter" ref={box} role="img" aria-label="Master level">
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
        if (label.current) label.current.textContent = 'HOT · ' + loudest.name
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
      title="Lights up when the mix is too hot (the limiter works hard): turn down the gain or fader of that source"
    />
  )
}

/**
 * Top bar: name, REC, PANIC and master level on the left; the bar counter and what the app is busy
 * with in the middle; clock with the set countdown, notes, SIMPLE / PRO and Settings on the right.
 */
export function TopBar() {
  const mix = useStore(mixer)
  const bpm = useStore(bpmStore)
  const lib = useStore(library)
  const a = useStore(deckA)
  const b = useStore(deckB)
  const lyr = useStore(lyrics)
  const set = useStore(settings)
  const open = useStore(ui).settings !== null
  const up = useStore(updates)
  const pan = useStore(panic)
  const mode = useStore(ui).mode
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
  for (const [name, p] of Object.entries(lyr.working)) busy.push('Lyrics ' + name + ' ' + Math.round(p * 100) + '%')
  if (lib.analyzing) busy.push('Measuring BPM and key')
  if (lib.separating)
    busy.push(
      'Library stems ' +
        Math.round(lib.sepProgress * 100) +
        '%' +
        (lib.stemsWaiting.length ? ' (+' + lib.stemsWaiting.length + ')' : ''),
    )
  if (bpm.looking.length) busy.push('Looking for BPM of ' + bpm.looking.length)

  return (
    <header className="topbar">
      {/* Left: the name, then what is live — recording, panic, the hour and the master level. */}
      <div className="tb-left">
        {/* The painted X is the logo and the last letter of the name at once. */}
        <h1 aria-label="RiddimX">
          <b className="rx-name" aria-hidden="true">
            Riddim
            <img className="rx-x" src={logo} alt="" />
          </b>
        </h1>
        <button
          className={'rec' + (mix.recording ? ' on' : '')}
          aria-pressed={mix.recording}
          onClick={() => mixer.toggleRecording()}
          title={mix.recording ? 'Stop and save the recording' : 'Record the mix'}
        >
          <i />
          {mix.recording ? Math.floor(recorded / 60) + ':' + String(recorded % 60).padStart(2, '0') : 'REC'}
        </button>
        <button
          className={'tb-panic' + (pan.busy ? ' busy' : '')}
          onClick={() => void panic.run()}
          disabled={pan.busy}
          title="PANIC: stops every echo tail and stuck sound, reopens the sound card on the same outputs (fixes a changed sample rate, crackle or silence). The music keeps its place. If the engine is still stuck, the window restarts and the tracks come back on their decks."
        >
          {pan.busy ? 'RESETTING…' : 'PANIC'}
        </button>
        <LiveBar />
        <HotSource />
        <MasterMeter />
      </div>
      {set.beatCounter && <BeatCounter />}
      <div className="tb-status" aria-live="polite">
        {busy.map((text) => (
          <span key={text} className="tb-busy">
            <i aria-hidden="true" />
            {text}
          </span>
        ))}
      </div>
      {/* Right: how the app looks and how it is set up. */}
      <div className="top-actions">
        {/* A new version is offered in a toast; the top bar only keeps the download / ready state. */}
        {(up.status === 'downloading' || up.status === 'ready') && (
          <button
            className={'tb-update' + (up.status === 'ready' ? ' ready' : '')}
            onClick={() => (up.status === 'ready' ? updates.install() : ui.openSettings('geral'))}
            title={(up.notes ? "What's new:\n" + up.notes + '\n\n' : '') + updateText(up)}
          >
            <i aria-hidden="true" />
            {up.status === 'ready'
              ? 'Restart and update to ' + up.version
              : 'Version ' + up.version + (up.status === 'downloading' ? ' · ' + Math.round((up.progress ?? 0) * 100) + '%' : '')}
          </button>
        )}
        <ClockAndSet />
        <NotesButton />
        <div className="tb-mode" role="radiogroup" aria-label="Interface">
          <button
            role="radio"
            aria-checked={mode === 'simple'}
            className={mode === 'simple' ? 'on' : ''}
            onClick={() => ui.setMode('simple')}
            title="Simple: decks, a basic mixer, DUB and FIRE. Everything else stays where it is, out of sight"
          >
            SIMPLE
          </button>
          <button
            role="radio"
            aria-checked={mode === 'pro'}
            className={mode === 'pro' ? 'on' : ''}
            onClick={() => ui.setMode('pro')}
            title="Pro: every unit on screen (isolator, sound system, mic, transitions, all pad modes and FX)"
          >
            PRO
          </button>
        </div>
        <button
          className={'tb-gear' + (open ? ' on' : '')}
          onClick={() => ui.openSettings(open ? null : 'geral')}
          title="Settings: audio interface, controller, keyboard, size and colours"
          aria-label="Settings"
          aria-expanded={open}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M10.3 3h3.4l.5 2.4 1.6.9 2.3-.8 1.7 2.9-1.8 1.6v1.9l1.8 1.6-1.7 2.9-2.3-.8-1.6.9-.5 2.4h-3.4l-.5-2.4-1.6-.9-2.3.8-1.7-2.9 1.8-1.6v-1.9L4.2 8.4l1.7-2.9 2.3.8 1.6-.9z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <circle cx="12" cy="12" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </div>
      <SetWidget />
    </header>
  )
}
