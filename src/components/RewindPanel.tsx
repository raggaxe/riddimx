import { REWIND_LIMITS, REWIND_PRESETS, rewindSettings, type RewindSettings } from '../engine/rewind'
import { SFX } from '../engine/soundsystem'
import { useStore } from '../store'

type Numeric = keyof typeof REWIND_LIMITS

const SLIDERS: { key: Numeric; label: string; hint: string; step: number; show: (v: number) => string }[] = [
  { key: 'duration', label: 'Length', hint: 'How long the rewind sound lasts', step: 0.05, show: (v) => v.toFixed(2) + ' s' },
  { key: 'tape', label: 'Rewind', hint: 'How many seconds of music go backwards', step: 0.1, show: (v) => v.toFixed(1) + ' s' },
  { key: 'startSpeed', label: 'Start speed', hint: 'Speed at the start (1× = normal)', step: 0.05, show: (v) => v.toFixed(2) + '×' },
  {
    key: 'endSpeed',
    label: 'End speed',
    hint: 'Speed at the end; higher = higher and faster',
    step: 0.1,
    show: (v) => v.toFixed(1) + '×',
  },
  {
    key: 'fadeAt',
    label: 'Starts to fade',
    hint: 'Where in the rewind the sound starts to disappear',
    step: 0.01,
    show: (v) => Math.round(v * 100) + '%',
  },
  { key: 'muffle', label: 'Muffle', hint: 'How much the sound darkens as it spins', step: 0.01, show: (v) => Math.round(v * 100) + '%' },
]

const AFTER: { value: RewindSettings['after']; label: string }[] = [
  { value: 'cue', label: 'Stop on the cue' },
  { value: 'drop', label: 'Relaunch from the cue' },
  { value: 'stay', label: 'Stop where it was' },
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
          <span>Shout</span>
          <select value={r.shout} onChange={(e) => rewindSettings.update({ shout: e.target.value })}>
            <option value="">None</option>
            {SFX.map((fx) => (
              <option key={fx.id} value={fx.id}>
                {fx.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>After</span>
          <select value={r.after} onChange={(e) => rewindSettings.update({ after: e.target.value as RewindSettings['after'] })}>
            {AFTER.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">Applies to the ◀◀ button of both decks and to the controller. Try it with a track playing.</p>
    </section>
  )
}
