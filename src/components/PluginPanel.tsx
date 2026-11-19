import { AUX_FX, plugin } from '../engine/plugin'
import { STEMS, type Stem } from '../engine/stems'
import { useStore } from '../store'
import { Knob } from './Knob'
import { MixSection } from './MasterStrip'

const pct = (v: number) => Math.round(v * 100) + '%'
const STEM_NAME: Record<Stem, string> = { vocal: 'VOCAL', instr: 'INSTR', bass: 'BASS', kick: 'KICK', hat: 'HATS' }

/**
 * Plugin tab: two AUX effects fed by the stems. Each knob in the grid sends one stem of one deck
 * (after its fader) into that AUX; the AUX returns into the master.
 */
export function PluginPanel() {
  const p = useStore(plugin)
  return (
    <div className="plg">
      {p.aux.map((aux, i) => {
        const fx = AUX_FX.find((f) => f.id === aux.fx)!
        const sending = (['A', 'B'] as const).some((d) => STEMS.some((st) => p.send[i][d][st] > 0))
        return (
          <MixSection key={i} title={'AUX ' + (i + 1) + ' · ' + fx.label} className={'plg-aux' + (sending ? ' on' : '')}>
            <div className="plg-head">
              <div className="seg" role="radiogroup" aria-label={'AUX ' + (i + 1) + ' effect'}>
                {AUX_FX.map((f) => (
                  <button
                    key={f.id}
                    role="radio"
                    aria-checked={aux.fx === f.id}
                    className={aux.fx === f.id ? 'on' : ''}
                    title={f.hint}
                    onClick={() => plugin.updateAux(i, { fx: f.id })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <Knob label={fx.a} value={aux.a} min={0} max={1} reset={0.5} format={pct} onChange={(v) => plugin.updateAux(i, { a: v })} />
              <Knob label={fx.b} value={aux.b} min={0} max={1} reset={0.5} format={pct} onChange={(v) => plugin.updateAux(i, { b: v })} />
              <Knob label="RETURN" value={aux.ret} min={0} max={1} reset={0.7} format={pct} onChange={(v) => plugin.updateAux(i, { ret: v })} />
              <button className="btn small" disabled={!sending} onClick={() => plugin.clearSends(i)} title="Every send of this AUX back to zero">
                Clear sends
              </button>
            </div>
            <div className="plg-grid" role="group" aria-label={'Stem sends into AUX ' + (i + 1)}>
              {(['A', 'B'] as const).map((d) => (
                <div key={d} className={'plg-row ' + d.toLowerCase()}>
                  <em>{d}</em>
                  {STEMS.map((st) => (
                    <Knob
                      key={st}
                      label={STEM_NAME[st]}
                      value={p.send[i][d][st]}
                      min={0}
                      max={1}
                      reset={0}
                      format={pct}
                      onChange={(v) => plugin.setSend(i, d, st, v)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </MixSection>
        )
      })}
      <p className="plg-note">
        Sends follow each deck's fader and its stem pads. Third-party VST3 plugins are not supported yet: they need a native audio host inside the app.
      </p>
    </div>
  )
}
