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
          <span>caixas · o que a pista ouve</span>
          {m.splitAvailable && <i className="ap2-tag">4 canais</i>}
        </header>
        <div className="ap2-body">
          <select
            value={m.masterDevice}
            aria-label="Output do master"
            title="Placa ou controladora de 4 canais: escolha ela aqui e “Canais 3-4” no headphone"
            onChange={(e) => void mixer.setMasterDevice(e.target.value)}
          >
            <option value="">Padrão do sistema</option>
            {m.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ap2-btn" onClick={() => mixer.testTone('master')} title="Três bips no master">
            TESTAR
          </button>
        </div>
      </section>

      <section className={'mx-sec ap2-unit' + (hpOn ? '' : ' off')} aria-label="Headphone">
        <header className="ap2-head">
          <b>Headphone</b>
          <span>cue · só você ouve</span>
        </header>
        <div className="ap2-body">
          <select
            value={m.hpDevice}
            aria-label="Output do headphone"
            title="Sem placa de 4 canais: master num output e headphone em outro (ex.: caixas USB ou Bluetooth e a saída de fone do Mac)"
            onChange={(e) => void mixer.setHeadphoneDevice(e.target.value)}
          >
            <option value="">Desligado</option>
            {m.splitAvailable && <option value="split">Canais 3-4 da placa do master</option>}
            {m.devices
              .filter((d) => d.id !== m.masterDevice)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
          </select>
          <button className="ap2-btn" disabled={!hpOn} onClick={() => mixer.testTone('phones')} title="Três bips no headphone">
            TESTAR
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

      <section className="mx-sec ap2-unit" aria-label="Input do microfone">
        <header className="ap2-head">
          <b>Input mic</b>
          <span>voz e gravação de drops</span>
        </header>
        <div className="ap2-body">
          <select
            value={m.inputDevice}
            aria-label="Input do microfone"
            title="Entrada de onde vem o microfone: a da placa (XLR / P10) ou o mic do Mac"
            onChange={(e) => {
              mixer.setInputDevice(e.target.value)
              void mic.reopen()
            }}
          >
            <option value="">Padrão do sistema</option>
            {m.inputs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      <section className="mx-sec ap2-unit ap2-sys" aria-label="Sistema de áudio">
        <header className="ap2-head">
          <b>Sistema</b>
        </header>
        <div className="ap2-body">
          <span className="ap2-info">
            {Math.round(ctx.sampleRate / 100) / 10} kHz{latency > 0 && ' · latência ≈ ' + latency + ' ms'} · {m.devices.length}{' '}
            {m.devices.length === 1 ? 'output' : 'outputs'} · {m.inputs.length} {m.inputs.length === 1 ? 'input' : 'inputs'}
          </span>
          <button
            className="ap2-btn"
            onClick={() => void mixer.refreshDevices()}
            title="Procurar a placa de novo (depois de conectar)"
          >
            ATUALIZAR
          </button>
        </div>
      </section>

      {m.audioError && <p className="deck-msg error ap2-err">{m.audioError}</p>}
      <p className="ap2-hint">
        <b>Placa de áudio:</b> conecte no USB, clique em ATUALIZAR, escolha a placa no Output master e aperte TESTAR. Placa
        de 4 canais (ou controladora com saída de fone): no Headphone escolha “Canais 3-4”. Sem placa: master nas caixas
        e headphone na saída de fone do Mac. O botão de fone de cada canal no mixer manda o deck para o cue, mesmo com o
        fader embaixo.
      </p>
    </div>
  )
}
