import { useEffect } from 'react'
import { mixer } from '../engine/mixer'
import { useStore } from '../store'
import { Knob } from './Knob'

/** Where the sound goes: speakers (master) and headphones (pre-listen), side by side, each with a test. */
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
      <section className="mx-sec ap2-unit" aria-label="Colunas">
        <header className="ap2-head">
          <b>Colunas</b>
          <span>master · o que a pista ouve</span>
          {m.splitAvailable && <i className="ap2-tag">4 canais</i>}
        </header>
        <div className="ap2-body">
          <select
            value={m.masterDevice}
            aria-label="Saída das colunas"
            title="Controladora com placa de 4 canais: escolhe-a aqui e “Canais 3-4” nos auscultadores"
            onChange={(e) => void mixer.setMasterDevice(e.target.value)}
          >
            <option value="">Predefinição do sistema</option>
            {m.devices.map((d) => (
              <option key={d.id} value={d.id}>
                {d.label}
              </option>
            ))}
          </select>
          <button className="ap2-btn" onClick={() => mixer.testTone('master')} title="Três bips nas colunas">
            TESTAR
          </button>
        </div>
      </section>

      <section className={'mx-sec ap2-unit' + (hpOn ? '' : ' off')} aria-label="Auscultadores">
        <header className="ap2-head">
          <b>Auscultadores</b>
          <span>pré-escuta · só para ti</span>
        </header>
        <div className="ap2-body">
          <select
            value={m.hpDevice}
            aria-label="Saída dos auscultadores"
            title="Sem controladora: colunas numa saída e auscultadores noutra (ex.: colunas USB ou Bluetooth e a saída de fones do Mac)"
            onChange={(e) => void mixer.setHeadphoneDevice(e.target.value)}
          >
            <option value="">Desligado</option>
            {m.splitAvailable && <option value="split">Canais 3-4 da placa das colunas</option>}
            {m.devices
              .filter((d) => d.id !== m.masterDevice)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
          </select>
          <button className="ap2-btn" disabled={!hpOn} onClick={() => mixer.testTone('phones')} title="Três bips nos auscultadores">
            TESTAR
          </button>
          <div className={'ap2-knobs' + (hpOn ? '' : ' bypassed')}>
            <Knob label="FONES" value={m.hpVolume} min={0} max={1} reset={0.8} format={pct} onChange={(v) => mixer.setHeadphoneVolume(v)} />
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

      <section className="mx-sec ap2-unit ap2-sys" aria-label="Sistema de áudio">
        <header className="ap2-head">
          <b>Sistema</b>
        </header>
        <div className="ap2-body">
          <span className="ap2-info">
            {Math.round(ctx.sampleRate / 100) / 10} kHz{latency > 0 && ' · latência ≈ ' + latency + ' ms'} · {m.devices.length}{' '}
            {m.devices.length === 1 ? 'saída' : 'saídas'}
          </span>
          <button
            className="ap2-btn"
            onClick={() => void mixer.refreshDevices()}
            title="Procurar saídas de novo (depois de ligar uma placa)"
          >
            ATUALIZAR
          </button>
        </div>
      </section>

      {m.audioError && <p className="deck-msg error ap2-err">{m.audioError}</p>}
      <p className="ap2-hint">O botão de fones de cada canal no mixer manda esse deck para a pré-escuta, mesmo com o fader em baixo.</p>
    </div>
  )
}
