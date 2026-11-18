import { useStore } from '../store'
import { DEFAULT_SETTINGS, ZOOM_MAX, ZOOM_MIN, settings, type Settings } from '../settings'
import { updateText, updates } from '../updates'

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl'

/** Colour pairs to try quickly (A, B). The first is the app's own. */
const PAIRS: [string, string, string][] = [
  ['Rasta', '#f2c230', '#35c46a'],
  ['Clássico', '#4aa8ff', '#e5484d'],
  ['Fogo', '#ff8a3d', '#c77dff'],
  ['Gelo', '#7fdcff', '#f4f4f4'],
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
      <section className="mx-sec ap2-unit" aria-label="Tamanho da interface">
        <header className="ap2-head">
          <b>Tamanho</b>
          <span>
            letras e controles · {MOD} + / {MOD} − / {MOD} 0
          </span>
        </header>
        <div className="ap2-body">
          <button className="ap2-btn" onClick={() => settings.zoomBy(-1)} disabled={s.zoom <= ZOOM_MIN} aria-label="Menor">
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
            aria-label="Tamanho da interface"
          />
          <button className="ap2-btn" onClick={() => settings.zoomBy(1)} disabled={s.zoom >= ZOOM_MAX} aria-label="Maior">
            A+
          </button>
          <span className="ap2-info st-num">{Math.round(s.zoom * 100)}%</span>
          <button className="ap2-btn" onClick={() => settings.update({ zoom: 1 })} disabled={s.zoom === 1}>
            100%
          </button>
        </div>
      </section>

      <section className="mx-sec ap2-unit" aria-label="Cores dos decks">
        <header className="ap2-head">
          <b>Cores dos decks</b>
          <span>ondas, botões e contador</span>
        </header>
        <div className="ap2-body">
          <label className="st-color" title="Cor do deck A">
            <input type="color" value={s.colorA} onChange={(e) => settings.update({ colorA: e.target.value })} />A
          </label>
          <label className="st-color" title="Cor do deck B">
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

      <section className="mx-sec ap2-unit st-opts" aria-label="Jog e pista">
        <header className="ap2-head">
          <b>Jog e pista</b>
        </header>
        <div className="st-list">
          {toggle('snapBars', 'Ímã no compasso', 'Com o deck parado, o jog e a pista grudam de leve na cabeça de cada compasso')}
          {toggle('jogInertia', 'Inércia do jog na tela', 'Jogar o disco com o mouse faz ele continuar girando')}
          {toggle('beatCounter', 'Contador de tempos', 'Os 4 retângulos de cada deck no topo')}
        </div>
      </section>

      <section className="mx-sec ap2-unit" aria-label="Atualizações">
        <header className="ap2-head">
          <b>Atualizações</b>
          <span>{up.current ? 'versão ' + up.current : 'automáticas'}</span>
        </header>
        <div className="ap2-body">
          <span className="ap2-info st-update">{updateText(up) || 'Procura sozinha ao abrir e a cada 6 horas'}</span>
          {up.status === 'ready' ? (
            <button className="ap2-btn st-go" onClick={() => updates.install()}>
              REINICIAR E ATUALIZAR
            </button>
          ) : (
            <button
              className="ap2-btn"
              onClick={() => updates.check()}
              disabled={up.status === 'dev' || up.status === 'checking' || up.status === 'downloading'}
            >
              PROCURAR AGORA
            </button>
          )}
        </div>
        {up.notes && (up.status === 'ready' || up.status === 'downloading' || up.status === 'available') && (
          <pre className="st-notes">{up.notes}</pre>
        )}
      </section>

      <section className="mx-sec ap2-unit" aria-label="Restaurar">
        <header className="ap2-head">
          <b>Padrão</b>
        </header>
        <div className="ap2-body">
          <button
            className="ap2-btn"
            onClick={() => settings.reset()}
            disabled={JSON.stringify(s) === JSON.stringify(DEFAULT_SETTINGS)}
          >
            RESTAURAR TUDO
          </button>
        </div>
      </section>
    </div>
  )
}
