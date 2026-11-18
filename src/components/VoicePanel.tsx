import { mic, VOICE_PRESETS, VOICE_TIMES, type VoiceTime } from '../engine/mic'
import { useStore } from '../store'
import { Knob } from './Knob'
import { MixSection } from './MasterStrip'

const pct = (v: number) => Math.round(v * 100) + '%'

/**
 * The MC's voice, in full (its own tab at the bottom): on air, colour (filter and drive), its own
 * tape echo with a THROW, its spring, and ready-made voices. The mixer keeps the quick controls.
 */
export function VoicePanel() {
  const m = useStore(mic)
  const preset = mic.preset
  const hold = {
    onPointerDown: (e: React.PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId)
      mic.throwVoice(true)
    },
    onPointerUp: () => mic.throwVoice(false),
    onPointerCancel: () => mic.throwVoice(false),
  }
  return (
    <div className="echo-desk voice-desk">
      <MixSection title={m.error ? 'Mic · sem acesso' : m.talk ? 'Mic · no ar' : 'Mic'} className="voice-air">
        <button
          className={'mx-talk' + (m.talk ? ' on' : '') + (m.speaking ? ' speaking' : '') + (m.error ? ' err' : '')}
          aria-pressed={m.talk}
          onClick={() => {
            if (m.error && /Privacidade/.test(m.error)) mic.openSettings()
            mic.setTalk(!m.talk)
          }}
          title={m.error ?? (m.talk ? 'Fechar o microfone' : 'Abrir o microfone para a pista')}
        >
          <i aria-hidden="true" />
          {m.talk ? 'NO AR' : m.error ? 'SEM MIC' : 'FALAR'}
        </button>
        <Knob label="NÍVEL" value={m.level} min={0} max={1.5} reset={1} format={pct} onChange={(v) => mic.update({ level: v })} />
        <Knob
          label="BAIXAR"
          value={m.duck}
          min={0}
          max={1}
          reset={0.5}
          format={(v) => (v < 0.02 ? 'nunca' : '−' + Math.round(-20 * Math.log10(1 - v * 0.75)) + ' dB')}
          onChange={(v) => mic.update({ duck: v })}
        />
      </MixSection>
      <MixSection title="Voz pronta" className="voice-presets">
        <div className="voice-preset-grid">
          {VOICE_PRESETS.map((p) => (
            <button
              key={p.id}
              className={'voice-preset' + (preset === p.id ? ' on' : '')}
              aria-pressed={preset === p.id}
              onClick={() => mic.usePreset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </MixSection>
      <MixSection title="Cor" className="voice-colour">
        <Knob
          label="FILTRO"
          value={m.filter}
          min={-1}
          max={1}
          reset={0}
          format={(v) =>
            Math.abs(v) < 0.02 ? 'aberto' : v < 0 ? 'escuro ' + Math.round(-v * 100) + '%' : 'rádio ' + Math.round(v * 100) + '%'
          }
          onChange={(v) => mic.update({ filter: v })}
        />
        <Knob
          label="DRIVE"
          value={m.drive}
          min={0}
          max={1}
          reset={0}
          format={(v) => (v < 0.02 ? 'limpo' : v > 0.7 ? 'megafone' : pct(v))}
          onChange={(v) => mic.update({ drive: v })}
        />
      </MixSection>
      <MixSection title="Eco da voz" className="voice-echo">
        <button
          className={'ru-throw voice-throw' + (m.throwing ? ' on' : '')}
          {...hold}
          title="Segure: a voz entra toda no eco (abre o mic). Solte e as repetições continuam"
        >
          THROW VOZ
        </button>
        <select
          className="ru-select"
          value={m.time}
          aria-label="Tempo do eco da voz"
          title="Tempo do eco da voz: igual ao Eco fita, ou uma divisão da batida só para a voz"
          onChange={(e) => mic.update({ time: e.target.value as VoiceTime })}
        >
          {VOICE_TIMES.map((t) => (
            <option key={t} value={t}>
              {t === 'rack' ? 'igual ao Eco fita' : t}
            </option>
          ))}
        </select>
        <Knob label="ENVIO" value={m.echo} min={0} max={1} reset={0.4} format={pct} onChange={(v) => mic.update({ echo: v })} />
        <Knob label="REPETIR" value={m.repeats} min={0} max={0.95} reset={0.5} format={pct} onChange={(v) => mic.update({ repeats: v })} />
        <Knob
          label="TOM"
          value={m.tone}
          min={0}
          max={1}
          reset={0.5}
          format={(v) => (v < 0.35 ? 'escuro' : v > 0.7 ? 'claro' : 'fita')}
          onChange={(v) => mic.update({ tone: v })}
        />
      </MixSection>
      <MixSection title="Mola" className="voice-spring">
        <Knob label="MOLA" value={m.spring} min={0} max={1} reset={0.25} format={pct} onChange={(v) => mic.update({ spring: v })} />
      </MixSection>
      <MixSection title="Saída" className="voice-out">
        <Knob label="EFEITOS" value={m.fx} min={0} max={1.5} reset={1} format={pct} onChange={(v) => mic.update({ fx: v })} />
      </MixSection>
    </div>
  )
}
