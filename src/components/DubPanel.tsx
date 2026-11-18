import { DUB_BEATS, DUB_LIMITS, DUB_PRESETS, dubSettings, type DubSettings } from '../engine/dub'
import { useStore } from '../store'

type Numeric = keyof typeof DUB_LIMITS

const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const pct = (v: number): string => Math.round(v * 100) + '%'

const SLIDERS: { key: Numeric; label: string; hint: string; step: number; show: (v: number) => string }[] = [
  { key: 'feedback', label: 'Repetições', hint: 'Quanto de cada eco volta; mais alto = cauda mais longa', step: 0.01, show: pct },
  { key: 'level', label: 'Volume do eco', hint: 'Volume das repetições', step: 0.01, show: pct },
  { key: 'lowCut', label: 'Cortar graves', hint: 'Graves tirados antes do eco, para não embolar o baixo', step: 10, show: hz },
  { key: 'tone', label: 'Brilho', hint: 'Cada repetição fica mais escura a partir deste ponto, como fita gasta', step: 50, show: hz },
  { key: 'space', label: 'Mola', hint: 'Reverb de mola sobre as repetições', step: 0.01, show: pct },
  { key: 'drift', label: 'Fita', hint: 'Oscilação da fita: o tom do eco dobra um pouco', step: 0.01, show: pct },
]

type Choice<K extends keyof DubSettings> = { key: K; label: string; options: { value: DubSettings[K]; label: string }[] }

const CHOICES: [Choice<'dry'>, Choice<'release'>, Choice<'mode'>] = [
  {
    key: 'dry',
    label: 'Música',
    options: [
      { value: 'keep', label: 'Continua tocando' },
      { value: 'cut', label: 'Some, só eco' },
    ],
  },
  {
    key: 'release',
    label: 'Ao soltar',
    options: [
      { value: 'ring', label: 'Continua' },
      { value: 'fade', label: 'Morre rápido' },
    ],
  },
  {
    key: 'mode',
    label: 'Botão',
    options: [
      { value: 'hold', label: 'Segurar' },
      { value: 'latch', label: 'Liga / desliga' },
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
          <span>Tempo do eco</span>
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
        Vale para o botão DUB dos dois decks e para a controladora. Os ajustes mudam também um eco que já está soando. Sem BPM, o tempo do
        eco conta como 120 BPM.
      </p>
    </section>
  )
}
