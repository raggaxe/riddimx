import { REWIND_LIMITS, REWIND_PRESETS, rewindSettings, type RewindSettings } from '../engine/rewind'
import { SFX } from '../engine/soundsystem'
import { useStore } from '../store'

type Numeric = keyof typeof REWIND_LIMITS

const SLIDERS: { key: Numeric; label: string; hint: string; step: number; show: (v: number) => string }[] = [
  { key: 'duration', label: 'Duração', hint: 'Quanto tempo dura o som do rewind', step: 0.05, show: (v) => v.toFixed(2) + ' s' },
  { key: 'tape', label: 'Recuo', hint: 'Quantos segundos de música andam para trás', step: 0.1, show: (v) => v.toFixed(1) + ' s' },
  { key: 'startSpeed', label: 'Arranque', hint: 'Velocidade ao começar (1× = normal)', step: 0.05, show: (v) => v.toFixed(2) + '×' },
  {
    key: 'endSpeed',
    label: 'Velocidade final',
    hint: 'Velocidade no fim; mais alto = mais agudo e rápido',
    step: 0.1,
    show: (v) => v.toFixed(1) + '×',
  },
  {
    key: 'fadeAt',
    label: 'Começa a sumir',
    hint: 'Em que ponto do rewind o som começa a desaparecer',
    step: 0.01,
    show: (v) => Math.round(v * 100) + '%',
  },
  { key: 'muffle', label: 'Abafar', hint: 'Quanto o som escurece enquanto roda', step: 0.01, show: (v) => Math.round(v * 100) + '%' },
]

const AFTER: { value: RewindSettings['after']; label: string }[] = [
  { value: 'cue', label: 'Parar no cue' },
  { value: 'drop', label: 'Relançar do cue' },
  { value: 'stay', label: 'Parar onde estava' },
]

/** Settings of the ◀◀ button (rewind / pull up), with presets. */
export function RewindPanel() {
  const r = useStore(rewindSettings)
  const active = REWIND_PRESETS.find((p) => (Object.keys(p.settings) as (keyof RewindSettings)[]).every((k) => p.settings[k] === r[k]))

  return (
    <section className="rewind-panel" aria-labelledby="rewind-title">
      <header>
        <h3 id="rewind-title">Rewind ◀◀</h3>
        <div className="rw-presets">
          {REWIND_PRESETS.map((p) => (
            <button
              key={p.name}
              className={'sfx' + (active === p ? ' on' : '')}
              aria-pressed={active === p}
              onClick={() => rewindSettings.update(p.settings)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </header>
      <div className="rw-grid">
        {SLIDERS.map((s) => (
          <label key={s.key} title={s.hint}>
            <span>{s.label}</span>
            <input
              type="range"
              min={REWIND_LIMITS[s.key][0]}
              max={REWIND_LIMITS[s.key][1]}
              step={s.step}
              value={r[s.key]}
              onChange={(e) => rewindSettings.update({ [s.key]: Number(e.target.value) })}
            />
            <output>{s.show(r[s.key])}</output>
          </label>
        ))}
        <label>
          <span>Grito</span>
          <select value={r.shout} onChange={(e) => rewindSettings.update({ shout: e.target.value })}>
            <option value="">Nenhum</option>
            {SFX.map((fx) => (
              <option key={fx.id} value={fx.id}>
                {fx.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Depois</span>
          <select value={r.after} onChange={(e) => rewindSettings.update({ after: e.target.value as RewindSettings['after'] })}>
            {AFTER.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">Vale para o botão ◀◀ dos dois decks e para a controladora. Experimenta com uma música a tocar.</p>
    </section>
  )
}
