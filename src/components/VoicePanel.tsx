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
      <MixSection title={m.error ? 'Mic · no access' : m.talk ? 'Mic · on air' : 'Mic'} className="voice-air">
        <button
          className={'mx-talk' + (m.talk ? ' on' : '') + (m.speaking ? ' speaking' : '') + (m.error ? ' err' : '')}
          aria-pressed={m.talk}
          onClick={() => {
            if (m.error && /Privacidade/.test(m.error)) mic.openSettings()
            mic.setTalk(!m.talk)
          }}
          title={m.error ?? (m.talk ? 'Close the mic' : 'Open the mic to the floor')}
        >
          <i aria-hidden="true" />
          {m.talk ? 'ON AIR' : m.error ? 'NO MIC' : 'TALK'}
        </button>
        <Knob label="LEVEL" value={m.level} min={0} max={1.5} reset={1} format={pct} onChange={(v) => mic.update({ level: v })} />
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
      <MixSection title="Mic presets" className="voice-presets">
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
      <MixSection title="Colour" className="voice-colour">
        <Knob
          label="FILTER"
          value={m.filter}
          min={-1}
          max={1}
          reset={0}
          format={(v) =>
            Math.abs(v) < 0.02 ? 'open' : v < 0 ? 'dark ' + Math.round(-v * 100) + '%' : 'radio ' + Math.round(v * 100) + '%'
          }
          onChange={(v) => mic.update({ filter: v })}
        />
        <Knob
          label="DRIVE"
          value={m.drive}
          min={0}
          max={1}
          reset={0}
          format={(v) => (v < 0.02 ? 'clean' : v > 0.7 ? 'megaphone' : pct(v))}
          onChange={(v) => mic.update({ drive: v })}
        />
      </MixSection>
      <MixSection title="Mic echo" className="voice-echo">
        <button
          className={'ru-throw voice-throw' + (m.throwing ? ' on' : '')}
          {...hold}
          title="Hold: the voice goes fully into the echo (opens the mic). Let go and the repeats carry on"
        >
          MIC THROW
        </button>
        <select
          className="ru-select"
          value={m.time}
          aria-label="Mic echo time"
          title="Mic echo time: same as the tape echo, or a beat division for the mic only"
          onChange={(e) => mic.update({ time: e.target.value as VoiceTime })}
        >
          {VOICE_TIMES.map((t) => (
            <option key={t} value={t}>
              {t === 'rack' ? 'same as tape echo' : t}
            </option>
          ))}
        </select>
        <Knob label="SEND" value={m.echo} min={0} max={1} reset={0.4} format={pct} onChange={(v) => mic.update({ echo: v })} />
        <Knob label="FEEDBACK" value={m.repeats} min={0} max={0.95} reset={0.5} format={pct} onChange={(v) => mic.update({ repeats: v })} />
        <Knob
          label="TONE"
          value={m.tone}
          min={0}
          max={1}
          reset={0.5}
          format={(v) => (v < 0.35 ? 'dark' : v > 0.7 ? 'bright' : 'tape')}
          onChange={(v) => mic.update({ tone: v })}
        />
      </MixSection>
      <MixSection title="Spring" className="voice-spring">
        <Knob label="SPRING" value={m.spring} min={0} max={1} reset={0.25} format={pct} onChange={(v) => mic.update({ spring: v })} />
      </MixSection>
      <MixSection title="Output" className="voice-out">
        <Knob label="EFFECTS" value={m.fx} min={0} max={1.5} reset={1} format={pct} onChange={(v) => mic.update({ fx: v })} />
      </MixSection>
    </div>
  )
}
