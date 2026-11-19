import { useStore } from '../store'
import { DEFAULT_SETTINGS, ZOOM_MAX, ZOOM_MIN, settings, type Settings } from '../settings'
import { updateText, updates } from '../updates'

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Colour pairs to try quickly (A, B). The first is the app's own. */
const PAIRS: [string, string, string][] = [
  ['Rasta', '#f2c230', '#35c46a'],
  ['Classic', '#4aa8ff', '#e5484d'],
  ['Fire', '#ff8a3d', '#c77dff'],
  ['Ice', '#7fdcff', '#f4f4f4'],
]

/** Settings: size of the interface, deck colours and a few behaviours, all remembered. */
export function SettingsPanel() {
  const s = useStore(settings)
  const up = useStore(updates)
  const toggle = (key: keyof Settings, label: string, hint: string) => (
    <label className="st-check" title={hint}>
      <input type="checkbox" checked={!!s[key]} onChange={(e) => settings.update({ [key]: e.target.checked })} />
      <span>{label}</span>
      <small>{hint}</small>
    </label>
  )

  return (
    <div className="ap2 st">
      <section className="mx-sec ap2-unit" aria-label="Interface size">
        <header className="ap2-head">
          <b>Size</b>
          <span>
            lyrics and controls · {MOD} + / {MOD} − / {MOD} 0
          </span>
        </header>
        <div className="ap2-body">
          <button className="ap2-btn" onClick={() => settings.zoomBy(-1)} disabled={s.zoom <= ZOOM_MIN} aria-label="Smaller">
            A−
          </button>
          <input
            className="st-range"
            type="range"
            min={ZOOM_MIN}
            max={ZOOM_MAX}
            step={0.05}
            value={s.zoom}
            onChange={(e) => settings.update({ zoom: Number(e.target.value) })}
            aria-label="Interface size"
          />
          <button className="ap2-btn" onClick={() => settings.zoomBy(1)} disabled={s.zoom >= ZOOM_MAX} aria-label="Bigger">
            A+
          </button>
          <span className="ap2-info st-num">{Math.round(s.zoom * 100)}%</span>
          <button className="ap2-btn" onClick={() => settings.update({ zoom: 1 })} disabled={s.zoom === 1}>
            100%
          </button>
        </div>
      </section>

      <section className="mx-sec ap2-unit" aria-label="Deck colours">
        <header className="ap2-head">
          <b>Deck colours</b>
          <span>waveforms, buttons and counter</span>
        </header>
        <div className="ap2-body">
          <label className="st-color" title="Deck A colour">
            <input type="color" value={s.colorA} onChange={(e) => settings.update({ colorA: e.target.value })} />A
          </label>
          <label className="st-color" title="Deck B colour">
            <input type="color" value={s.colorB} onChange={(e) => settings.update({ colorB: e.target.value })} />B
          </label>
          {PAIRS.map(([name, a, b]) => (
            <button
              key={name}
              className={'ap2-btn st-pair' + (s.colorA === a && s.colorB === b ? ' on' : '')}
              onClick={() => settings.update({ colorA: a, colorB: b })}
              title={'Cores ' + name}
            >
              <i style={{ background: a }} />
              <i style={{ background: b }} />
              {name.toUpperCase()}
            </button>
          ))}
        </div>
      </section>

      <section className="mx-sec ap2-unit st-opts" aria-label="Jog and track">
        <header className="ap2-head">
          <b>Jog and track</b>
        </header>
        <div className="st-list">
          {toggle('snapBars', 'Snap to the bar', 'With the deck stopped, the jog and the track stick lightly to the head of each bar')}
          {toggle('jogInertia', 'On-screen jog inertia', 'Flicking the record with the mouse keeps it spinning')}
          {toggle('beatCounter', 'Beat counter', 'The 4 boxes of each deck on top')}
        </div>
      </section>

      <section className="mx-sec ap2-unit" aria-label="Updates">
        <header className="ap2-head">
          <b>Updates</b>
          <span>{up.current ? 'version ' + up.current : 'automatic'}</span>
        </header>
        <div className="ap2-body">
          <span className="ap2-info st-update">{updateText(up) || 'Checks by itself on start and every 6 hours'}</span>
          {up.status === 'ready' ? (
            <button className="ap2-btn st-go" onClick={() => updates.install()}>
              RESTART AND UPDATE
            </button>
          ) : (
            <button
              className="ap2-btn"
              onClick={() => updates.check()}
              disabled={up.status === 'dev' || up.status === 'checking' || up.status === 'downloading'}
            >
              CHECK NOW
            </button>
          )}
        </div>
        {up.notes && (up.status === 'ready' || up.status === 'downloading' || up.status === 'available') && (
          <pre className="st-notes">{up.notes}</pre>
        )}
      </section>

      <section className="mx-sec ap2-unit" aria-label="Restore">
        <header className="ap2-head">
          <b>Default</b>
        </header>
        <div className="ap2-body">
          <button
            className="ap2-btn"
            onClick={() => settings.reset()}
            disabled={JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS)}
          >
            RESTORE ALL
          </button>
        </div>
      </section>
    </div>
  )
}
