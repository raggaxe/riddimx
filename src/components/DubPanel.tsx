import { DUB_BEATS, DUB_LIMITS, DUB_PRESETS, dubSettings, type DubSettings } from '../engine/dub'
import { useStore } from '../store'

type Numeric = keyof typeof DUB_LIMITS

const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const pct = (v: number): string => Math.round(v * 100) + '%'

const SLIDERS: { key: Numeric; label: string; hint: string; step: number; show: (v: number) => string }[] = [
  { key: 'feedback', label: 'Feedback', hint: 'How much of each echo comes back; higher = longer tail', step: 0.01, show: pct },
  { key: 'level', label: 'Echo level', hint: 'Level of the repeats', step: 0.01, show: pct },
  { key: 'lowCut', label: 'Low cut', hint: 'Bass removed before the echo, so it doesn\'t muddy the low end', step: 10, show: hz },
  { key: 'tone', label: 'Tone', hint: 'Each repeat gets darker from this point, like worn tape', step: 50, show: hz },
  { key: 'space', label: 'Spring', hint: 'Spring reverb on the repeats', step: 0.01, show: pct },
  { key: 'drift', label: 'Tape', hint: 'Tape wobble: the echo\'s pitch bends a little', step: 0.01, show: pct },
]

type Choice<K extends keyof DubSettings> = { key: K; label: string; options: { value: DubSettings[K]; label: string }[] }

const CHOICES: [Choice<'dry'>, Choice<'release'>, Choice<'mode'>] = [
  {
    key: 'dry',
    label: 'Music',
    options: [
      { value: 'keep', label: 'Keeps playing' },
      { value: 'cut', label: 'Drops out, echo only' },
    ],
  },
  {
    key: 'release',
    label: 'On release',
    options: [
      { value: 'ring', label: 'Keeps going' },
      { value: 'fade', label: 'Dies fast' },
    ],
  },
  {
    key: 'mode',
    label: 'Button',
    options: [
      { value: 'hold', label: 'Hold' },
      { value: 'latch', label: 'Latch (on / off)' },
    ],
  },
]

/** Settings of the DUB button (echo throw), with presets. */
export function DubPanel() {
  const d = useStore(dubSettings)
  const active = DUB_PRESETS.find((p) => (Object.keys(p.settings) as (keyof DubSettings)[]).every((k) => p.settings[k] === d[k]))

  return (
    <section className="rewind-panel" aria-labelledby="dub-title">
      <header>
        <h3 id="dub-title">Dub</h3>
        <div className="rw-presets">
          {DUB_PRESETS.map((p) => (
            <button
              key={p.name}
              className={'sfx' + (active === p ? ' on' : '')}
              aria-pressed={active === p}
              onClick={() => dubSettings.update(p.settings)}
            >
              {p.name}
            </button>
          ))}
        </div>
      </header>
      <div className="rw-grid">
        <label className="pick">
          <span>Echo time</span>
          <select value={d.beats} onChange={(e) => dubSettings.update({ beats: Number(e.target.value) })}>
            {DUB_BEATS.map((b) => (
              <option key={b.value} value={b.value}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        {SLIDERS.map((s) => (
          <label key={s.key} title={s.hint}>
            <span>{s.label}</span>
            <input
              type="range"
              min={DUB_LIMITS[s.key][0]}
              max={DUB_LIMITS[s.key][1]}
              step={s.step}
              value={d[s.key]}
              onChange={(e) => dubSettings.update({ [s.key]: Number(e.target.value) })}
            />
            <output>{s.show(d[s.key])}</output>
          </label>
        ))}
        {CHOICES.map((c) => (
          <label key={c.key} className="pick">
            <span>{c.label}</span>
            <select value={d[c.key]} onChange={(e) => dubSettings.update({ [c.key]: e.target.value } as Partial<DubSettings>)}>
              {c.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="hint">
        Applies to the DUB button of both decks and to the controller. Changes also reach an echo that is already ringing. With no BPM, the echo time counts as 120 BPM.
      </p>
    </section>
  )
}
