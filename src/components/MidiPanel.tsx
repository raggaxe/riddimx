import { useEffect, useMemo, useState } from 'react'
import { actions, describeKey, midi, presets } from '../midi'
import { useStore } from '../store'

const TYPE_HINT = { button: 'botão', hold: 'manter', fader: 'fader', center: 'knob', jog: 'jog' }
const LS_GROUP = 'vx_midi_group'

/**
 * MIDI mapping, laid out like the other tabs: groups on the left, the group's functions in a compact
 * table, the controller's status and presets on top. "Aprender em sequência" walks through every
 * unmapped function of the group, one control at a time.
 */
export function MidiPanel() {
  const s = useStore(midi)
  const groups = useMemo(() => [...new Set(actions.map((a) => a.group))], [])
  const [group, setGroup] = useState(() => {
    try {
      const saved = localStorage.getItem(LS_GROUP)
      return saved && groups.includes(saved) ? saved : groups[0]
    } catch {
      return groups[0]
    }
  })
  const [preset, setPreset] = useState(presets[0]?.name ?? '')
  const [chain, setChain] = useState(false) // learning one function after another

  const open = (g: string) => {
    setGroup(g)
    setChain(false)
    if (s.learning) midi.learn(null)
    try {
      localStorage.setItem(LS_GROUP, g)
    } catch {
      /* not remembered */
    }
  }

  const rows = actions.filter((a) => a.group === group)
  const mapped = (id: string) => midi.keyFor(id) !== undefined
  const count = (g: string) => actions.filter((a) => a.group === g && mapped(a.id)).length

  // In a sequence: once the current function gets its control, move on to the next one still unmapped.
  useEffect(() => {
    if (!chain || s.learning) return
    const next = rows.find((a) => !mapped(a.id))
    if (next) midi.learn(next.id)
    else setChain(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, s.learning, s.mappings])

  if (!s.supported) {
    return <p className="empty">Este sistema não suporta MIDI.</p>
  }

  return (
    <div className="midi mp">
      <nav className="side-nav" aria-label="Grupos de funções">
        <h5>Funções</h5>
        {groups.map((g) => (
          <button
            key={g}
            className={'side-item mp-group' + (group === g ? ' active' : '')}
            aria-pressed={group === g}
            onClick={() => open(g)}
          >
            {g}
            <i>
              {count(g)}/{actions.filter((a) => a.group === g).length}
            </i>
          </button>
        ))}
      </nav>

      <section className="mp-main">
        <div className="mp-bar">
          <span className={'mp-status' + (s.connected && s.inputs.length ? ' on' : '')}>
            <i aria-hidden="true" />
            {!s.connected ? 'MIDI desligado' : s.inputs.length ? s.inputs.join(', ') : 'Nenhuma controladora. Liga-a por USB.'}
          </span>
          {!s.connected && (
            <button className="btn small" onClick={() => void midi.connect()}>
              Ligar MIDI
            </button>
          )}
          <span className="mp-signal" title="Último sinal recebido da controladora" aria-live="polite">
            {s.last ?? 'sem sinal'}
          </span>
          <span className="mp-preset">
            <select value={preset} aria-label="Mapeamento pronto" onChange={(e) => setPreset(e.target.value)}>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              disabled={!preset}
              onClick={() => midi.applyPreset(preset)}
              title="Substitui todos os mapeamentos atuais por este"
            >
              Aplicar
            </button>
          </span>
        </div>
        {s.error && <p className="deck-msg error">{s.error}</p>}

        <div className="mp-table">
          <table>
            <thead>
              <tr>
                <th>Função</th>
                <th className="c-type">Tipo</th>
                <th className="c-ctl">Controlo</th>
                <th className="c-act">
                  <button
                    className={'lib-sort mp-chain' + (chain ? ' on' : '')}
                    disabled={!s.connected || (!chain && rows.every((a) => mapped(a.id)))}
                    onClick={() => {
                      if (chain) {
                        setChain(false)
                        midi.learn(null)
                      } else setChain(true)
                    }}
                    title="Aprende uma a uma as funções deste grupo que ainda não têm controlo"
                  >
                    {chain ? 'Parar sequência' : 'Aprender em sequência'}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const key = midi.keyFor(a.id)
                const learning = s.learning === a.id
                return (
                  <tr key={a.id} className={learning ? 'learning' : key ? 'mapped' : ''}>
                    <td>{a.label}</td>
                    <td className="c-type">{TYPE_HINT[a.type]}</td>
                    <td className="c-ctl">{learning ? 'mexe o controlo…' : key ? describeKey(key) : '—'}</td>
                    <td className="c-act">
                      <button
                        className={'mp-learn' + (learning ? ' on' : '')}
                        disabled={!s.connected}
                        onClick={() => {
                          setChain(false)
                          midi.learn(a.id)
                        }}
                      >
                        {learning ? 'Cancelar' : key ? 'Mudar' : 'Aprender'}
                      </button>
                      <button
                        className="row-btn show x"
                        disabled={!key}
                        onClick={() => midi.unmap(a.id)}
                        aria-label={'Apagar mapeamento de ' + a.label}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
