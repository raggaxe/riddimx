import { useEffect } from 'react'
import { mixer } from '../engine/mixer'
import { mic } from '../engine/mic'
import { useStore } from '../store'
import { Knob } from './Knob'

/** The audio interface: where the sound goes (master, headphone) and where the microphone comes in. */
export function AudioPanel() {
  const m = useStore(mixer)
  useEffect(() => {
    void mixer.refreshDevices()
  }, [])

  const ctx = mixer.ctx
  const latency = Math.round(((ctx.baseLatency || 0) + ((ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)) * 1000)
  const hpOn = m.hpDevice !== ''

  const pct = (v: number) => Math.round(v * 100) + '%'

  return (
    <div className="ap2">
      <section className="mx-sec ap2-unit" aria-label="Output master">
        <header className="ap2-head">
          <b>Output master</b>
          <span>speakers · what the floor hears</span>
          {m.splitAvailable && <i className="ap2-tag">4 channels</i>}
        </header>
        <div className="ap2-body">
          <select
            value={m.masterDevice}
            aria-label="Master output"
            title="4-channel interface or controller: pick it here and “Channels 3-4” for the headphones"
            onChange={(e) => void mixer.setMasterDevice(e.target.value)}
          >
            <option value="">System default</option>
            {m.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ap2-btn" onClick={() => mixer.testTone('master')} title="Three beeps on the master">
            TEST
          </button>
        </div>
      </section>

      <section className={'mx-sec ap2-unit' + (hpOn ? '' : ' off')} aria-label="Headphone">
        <header className="ap2-head">
          <b>Headphone</b>
          <span>cue · only you hear it</span>
        </header>
        <div className="ap2-body">
          <select
            value={m.hpDevice}
            aria-label="Headphone output"
            title="No 4-channel interface: master on one output and headphones on another (e.g. USB or Bluetooth speakers and the Mac's headphone jack)"
            onChange={(e) => void mixer.setHeadphoneDevice(e.target.value)}
          >
            <option value="">Off</option>
            {m.splitAvailable && <option value="split">Channels 3-4 of the master interface</option>}
            {m.devices
              .filter((d) => d.id !== m.masterDevice)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
          </select>
          <button className="ap2-btn" disabled={!hpOn} onClick={() => mixer.testTone('phones')} title="Three beeps in the headphones">
            TEST
          </button>
          <div className={'ap2-knobs' + (hpOn ? '' : ' bypassed')}>
            <Knob label="VOLUME" value={m.hpVolume} min={0} max={1} reset={0.8} format={pct} onChange={(v) => mixer.setHeadphoneVolume(v)} />
            <Knob
              label="CUE·MIX"
              value={m.cueMix}
              min={0}
              max={1}
              reset={0}
              format={(v) => (v < 0.03 ? 'CUE' : v > 0.97 ? 'MASTER' : pct(1 - v) + ' cue')}
              onChange={(v) => mixer.setCueMix(v)}
            />
          </div>
        </div>
      </section>

      <section className="mx-sec ap2-unit" aria-label="Microphone input">
        <header className="ap2-head">
          <b>Input mic</b>
          <span>mic and drop recording</span>
        </header>
        <div className="ap2-body">
          <select
            value={m.inputDevice}
            aria-label="Microphone input"
            title="Where the mic comes in: the interface's (XLR / jack) or the Mac's mic"
            onChange={(e) => {
              mixer.setInputDevice(e.target.value)
              void mic.reopen()
            }}
          >
            <option value="">System default</option>
            {m.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="mx-sec ap2-unit ap2-sys" aria-label="Audio system">
        <header className="ap2-head">
          <b>System</b>
        </header>
        <div className="ap2-body">
          <span className="ap2-info">
            {Math.round(ctx.sampleRate / 100) / 10} kHz{latency > 0 && ' · latency ≈ ' + latency + ' ms'} · {m.devices.length}{' '}
            {m.devices.length === 1 ? 'output' : 'outputs'} · {m.inputs.length} {m.inputs.length === 1 ? 'input' : 'inputs'}
          </span>
          <button
            className="ap2-btn"
            onClick={() => void mixer.refreshDevices()}
            title="Look for the interface again (after plugging it in)"
          >
            REFRESH
          </button>
        </div>
      </section>

      {m.audioError && <p className="deck-msg error ap2-err">{m.audioError}</p>}
      <p className="ap2-hint">
        <b>Audio interface:</b> plug it into USB, click REFRESH, pick the interface as Master output and press TEST. 4-channel interface (or a controller with a headphone out): pick “Channels 3-4” for the headphones. No interface: master on the speakers and headphones on the Mac's headphone jack. Each channel's headphone button in the mixer sends that deck to the cue, even with the fader down.
      </p>
    </div>
  )
}
