import { useState } from 'react'
import { useStore } from '../store'
import { ui } from '../ui'
import { Knob } from './Knob'
import { DubSoundMenu } from './DubSoundMenu'
import { SoundPads } from './MixerView'
import { EchoUnit } from './Rack'
import { deckA, deckB, type Deck } from '../engine/deck'
import { dubBox, FACTORY, PATCH_LIMITS } from '../engine/dubbox'
import { outboard } from '../engine/outboard'
import { DUB_BEATS, DUB_LIMITS, DUB_PRESETS, dubSettings } from '../engine/dub'
import { FX, type FxType } from '../engine/fx'
import { AUX_FX, plugin } from '../engine/plugin'

const pct = (v: number): string => Math.round(v * 100) + '%'
const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const toLog = (v: number, lo: number, hi: number): number => Math.log(v / lo) / Math.log(hi / lo)
const fromLog = (t: number, lo: number, hi: number): number => lo * Math.pow(hi / lo, t)
const filterText = (v: number): string =>
  Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? 'LP ' + Math.round(-v * 100) + '%' : 'HP ' + Math.round(v * 100) + '%'

const FX_LABEL: Record<FxType, string> = { echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER', wah: 'WAH' }

/** What kind of sound a Dub Box preset is, for the colour of its pad. */
function soundKind(name: string): string {
  const p = FACTORY.find((x) => x.name === name)?.patch
  if (!p) return 'mine'
  if (p.voice === 'siren') return 'siren'
  if (p.voice === 'spring') return 'spring'
  if (p.voice === 'noise') return 'noise'
  return 'fx'
}

/** A button that plays while held (pointer captured, so sliding off does not leave it stuck). */
function Hold({ className, on, label, title, press }: { className: string; on: boolean; label: string; title: string; press(down: boolean): void }) {
  return (
    <button
      className={className + (on ? ' on' : '')}
      title={title}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        press(true)
      }}
      onPointerUp={() => press(false)}
      onPointerCancel={() => press(false)}
    >
      {label}
    </button>
  )
}

/**
 * DUB page: the Dub Box played live. The sound and its knobs on top, the sounds as coloured pads
 * (quick pads 1–4, then the factory sounds), and DROP, FIRE and FX as the big buttons.
 */
export function DubPage() {
  const d = useStore(dubBox)
  const o = useStore(outboard)
  const pro = useStore(ui).mode === 'pro'
  const [sounds, setSounds] = useState(false)
  const [padPage, setPadPage] = useState(0)
  const p = d.patch
  const [pLo, pHi] = PATCH_LIMITS.pitch
  const [rLo, rHi] = PATCH_LIMITS.lfoRate
  const factory = FACTORY.filter((x) => !d.slots.some((s) => s?.name === x.name)).slice(0, 8 - d.slots.length)

  return (
    <div className="cp cp-dub">
      <div className="cp-row">
        <span className="cp-lab">Dub Box</span>
        <button className="cp-b cp-sq" onClick={() => dubBox.stepPreset(-1)} aria-label="Previous sound" title="Previous sound">
          ‹
        </button>
        <div className="cp-menu">
          <DubSoundMenu />
        </div>
        <button className="cp-b cp-sq" onClick={() => dubBox.stepPreset(1)} aria-label="Next sound" title="Next sound">
          ›
        </button>
        {pro && (
          <>
            <button className="cp-b" onClick={() => dubBox.surprise()} title="A random take on this sound, within values that sound good">
              SURPRISE
            </button>
            <button
              className={'cp-b' + (d.rehearse ? ' on' : '')}
              aria-pressed={d.rehearse}
              onClick={() => dubBox.setRehearse(!d.rehearse)}
              title="Hear the Dub Box in the headphones only, not on the floor"
            >
              REHEARSE
            </button>
          </>
        )}
        <button
          className={'cp-b' + (d.pfl ? ' on' : '')}
          aria-pressed={d.pfl}
          onClick={() => dubBox.togglePfl()}
          title="Pre-listen: hear the Dub Box in the headphones"
        >
          CUE
        </button>
      </div>

      <div className="cp-big">
        <button
          className={'cp-drop' + (o.dropping ? ' on' : '')}
          onClick={() => outboard.drop()}
          title="DROP: the bass out for one bar, back in on the one"
        >
          DROP
        </button>
        <Hold
          className="cp-fire"
          on={d.playing}
          label="FIRE"
          title={d.mode === 'hold' ? 'Hold: plays while pressed' : 'Latch: tap on, tap off'}
          press={(down) => dubBox.fire(down)}
        />
        <Hold
          className="cp-fxb"
          on={d.throwing}
          label="FX"
          title="FX: hold to throw everything into the Dub Box echo. Release: only the tail is left"
          press={(down) => dubBox.throw(down)}
        />
      </div>
      {pro && (
        <div className="cp-knobs">
          <Knob
            label="PITCH"
            value={toLog(p.pitch, pLo, pHi)}
            min={0}
            max={1}
            reset={toLog(440, pLo, pHi)}
            format={(v) => hz(fromLog(v, pLo, pHi))}
            onChange={(v) => dubBox.updatePatch({ pitch: fromLog(v, pLo, pHi) })}
          />
          <Knob
            label="LFO"
            value={toLog(p.lfoRate, rLo, rHi)}
            min={0}
            max={1}
            reset={toLog(1.6, rLo, rHi)}
            format={(v) => fromLog(v, rLo, rHi).toFixed(1) + ' Hz'}
            onChange={(v) => dubBox.updatePatch({ lfoRate: fromLog(v, rLo, rHi) })}
          />
          <Knob label="ECHO" value={p.echo} min={0} max={1} reset={0.5} format={pct} onChange={(v) => dubBox.updatePatch({ echo: v })} />
          <Knob label="FILTER" value={d.filter} format={filterText} onChange={(v) => dubBox.setFilter(v)} />
          <Knob label="LEVEL" value={d.level} min={0} max={1} reset={0.8} format={pct} onChange={(v) => dubBox.setLevel(v)} />
        </div>
      )}

      <div className="cp-seg" role="radiogroup" aria-label="Pads show">
        <button role="radio" aria-checked={!sounds} className={!sounds ? 'on' : ''} onClick={() => setSounds(false)}>
          DUB SOUNDS
        </button>
        <button role="radio" aria-checked={sounds} className={sounds ? 'on' : ''} onClick={() => setSounds(true)}>
          SAMPLER PADS
        </button>
      </div>

      {sounds ? (
        <div className="cp-sampler">
          <SoundPads page={padPage} setPage={setPadPage} />
        </div>
      ) : (
        <div className="cp-sounds">
          {d.slots.map((slot, i) => (
            <button
              key={'s' + i}
              className={'cp-sound k-' + (slot ? soundKind(slot.name) : 'empty') + (d.slotPlaying === i ? ' on' : '')}
              disabled={!slot}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                dubBox.fireSlot(i, true)
              }}
              onPointerUp={() => dubBox.fireSlot(i, false)}
              onPointerCancel={() => dubBox.fireSlot(i, false)}
              title={slot ? 'Quick pad ' + (i + 1) + ': ' + slot.name : 'Quick pad ' + (i + 1) + ': empty (save a sound in the Dub Box tab)'}
            >
              <small>PAD {i + 1}</small>
              <span>{slot?.name ?? 'empty'}</span>
            </button>
          ))}
          {factory.map((x) => (
            <button
              key={x.name}
              className={'cp-sound k-' + soundKind(x.name) + (d.preset === x.name ? ' now' : '')}
              onClick={() => dubBox.usePreset(x.name)}
              title={'Use ' + x.name + ' as the FIRE sound'}
            >
              <small>SOUND</small>
              <span>{x.name}</span>
            </button>
          ))}
        </div>
      )}


      <div className="cp-row">
        <span className="cp-lab">FIRE button</span>
        <div className="cp-seg" role="radiogroup" aria-label="FIRE button">
          <button role="radio" aria-checked={d.mode === 'hold'} className={d.mode === 'hold' ? 'on' : ''} onClick={() => dubBox.setMode('hold')}>
            HOLD
          </button>
          <button role="radio" aria-checked={d.mode === 'latch'} className={d.mode === 'latch' ? 'on' : ''} onClick={() => dubBox.setMode('latch')}>
            LATCH
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button className="cp-b" onClick={() => ui.open('dubbox')} title="Every Dub Box setting (Dub Box tab)">
          ALL SETTINGS
        </button>
      </div>
    </div>
  )
}

/** One deck's own effect: the effect, on / off, how much, and THROW into the tape echo. */
function DeckFx({ deck }: { deck: Deck }) {
  const s = useStore(deck)
  const o = useStore(outboard)
  const name = deck.name as 'A' | 'B'
  return (
    <section className={'cp-sec cp-deckfx ' + name.toLowerCase()} aria-label={'Deck ' + name + ' effect'}>
      <div className="cp-row">
        <span className="cp-tag">{name}</span>
        <span className="cp-lab" style={{ flex: 1 }}>
          Deck effect
        </span>
        <button
          className={'cp-b' + (s.fxOn ? ' on' : '')}
          aria-pressed={s.fxOn}
          disabled={!deck.canFx}
          onClick={() => deck.toggleFx()}
          title={deck.canFx ? 'Effect on / off' : 'Effects work on files, and on YouTube clips in the desktop app'}
        >
          {s.fxOn ? 'ON' : 'OFF'}
        </button>
      </div>
      <div className="cp-fxpick" role="radiogroup" aria-label={'Deck ' + name + ' effect type'}>
        {FX.map((fx) => (
          <button
            key={fx}
            role="radio"
            aria-checked={s.fx === fx}
            className={s.fx === fx ? 'on' : ''}
            disabled={!deck.canFx}
            onClick={() => deck.setFx(fx)}
          >
            {FX_LABEL[fx]}
          </button>
        ))}
      </div>
      <div className="cp-row">
        <Knob label="AMOUNT" value={s.fxAmount} min={0} max={1} reset={0.5} format={pct} onChange={(v) => deck.setFxAmount(v)} />
        <span style={{ flex: 1 }} />
        <Hold
          className="cp-b cp-throw"
          on={o.throwing[name]}
          label={'THROW ' + name}
          title={
            o.throwMode === 'bar'
              ? 'THROW into the tape echo: the music drops out, its last beat rings, it comes back on the next bar'
              : 'THROW into the tape echo while held'
          }
          press={(down) => outboard.throwPress(name, down)}
        />
      </div>
    </section>
  )
}

/**
 * FX page: each deck's effect, the DUB button's echo, the tape echo on the master and, in Pro, the
 * two AUX effects of the Plugin tab.
 */
export function FxPage() {
  const dub = useStore(dubSettings)
  const pg = useStore(plugin)
  const pro = useStore(ui).mode === 'pro'
  return (
    <div className="cp cp-fx">
      <div className="cp-two">
        <DeckFx deck={deckA} />
        <DeckFx deck={deckB} />
      </div>
      <section className="cp-sec" aria-label="Deck DUB button">
        <div className="cp-row">
          <span className="cp-lab" style={{ flex: 1 }}>
            Deck DUB button · both decks
          </span>
          <button className="cp-b" onClick={() => dubSettings.update({ ...DUB_PRESETS[0].settings })} title="Back to the Classic DUB">
            RESET
          </button>
          <button className="cp-b" onClick={() => ui.openSettings('decks')} title="Every DUB setting (Settings › Decks)">
            ALL SETTINGS
          </button>
        </div>
        <div className="cp-fxpick cp-presets" role="radiogroup" aria-label="DUB presets">
          {DUB_PRESETS.map((pr) => {
            const on = (Object.keys(pr.settings) as (keyof typeof pr.settings)[]).every((k) => dub[k] === pr.settings[k])
            return (
              <button key={pr.name} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => dubSettings.update({ ...pr.settings })}>
                {pr.name}
              </button>
            )
          })}
        </div>
        <div className="cp-knobs">
          <Knob
            label="TIME"
            value={Math.max(
              0,
              DUB_BEATS.findIndex((b) => b.value === dub.beats),
            )}
            min={0}
            max={DUB_BEATS.length - 1}
            reset={2}
            format={(v) => DUB_BEATS[Math.round(v)].label.replace(' beats', '').replace(' beat', '')}
            onChange={(v) => dubSettings.update({ beats: DUB_BEATS[Math.round(v)].value })}
          />
          <Knob
            label="FDBK"
            value={dub.feedback}
            min={DUB_LIMITS.feedback[0]}
            max={DUB_LIMITS.feedback[1]}
            reset={0.72}
            format={pct}
            onChange={(v) => dubSettings.update({ feedback: v })}
          />
          <Knob
            label="TONE"
            value={dub.tone}
            min={DUB_LIMITS.tone[0]}
            max={DUB_LIMITS.tone[1]}
            reset={3000}
            format={(v) => (v >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.round(v) + '')}
            onChange={(v) => dubSettings.update({ tone: v })}
          />
          <Knob
            label="LOW CUT"
            value={dub.lowCut}
            min={DUB_LIMITS.lowCut[0]}
            max={DUB_LIMITS.lowCut[1]}
            reset={380}
            format={(v) => Math.round(v) + ' Hz'}
            onChange={(v) => dubSettings.update({ lowCut: v })}
          />
          <Knob label="SPRING" value={dub.space} min={0} max={1} reset={0} format={pct} onChange={(v) => dubSettings.update({ space: v })} />
          <Knob
            label="LEVEL"
            value={dub.level}
            min={DUB_LIMITS.level[0]}
            max={DUB_LIMITS.level[1]}
            reset={1}
            format={pct}
            onChange={(v) => dubSettings.update({ level: v })}
          />
        </div>
        <div className="cp-row" style={{ flexWrap: 'wrap' }}>
          <div className="cp-seg" role="radiogroup" aria-label="DUB button">
            <button role="radio" aria-checked={dub.mode === 'hold'} className={dub.mode === 'hold' ? 'on' : ''} onClick={() => dubSettings.update({ mode: 'hold' })}>
              HOLD
            </button>
            <button role="radio" aria-checked={dub.mode === 'latch'} className={dub.mode === 'latch' ? 'on' : ''} onClick={() => dubSettings.update({ mode: 'latch' })}>
              LATCH
            </button>
          </div>
          <div className="cp-seg" role="radiogroup" aria-label="While DUB is held, the music">
            <button role="radio" aria-checked={dub.dry === 'keep'} className={dub.dry === 'keep' ? 'on' : ''} onClick={() => dubSettings.update({ dry: 'keep' })}>
              MUSIC KEEPS
            </button>
            <button role="radio" aria-checked={dub.dry === 'cut'} className={dub.dry === 'cut' ? 'on' : ''} onClick={() => dubSettings.update({ dry: 'cut' })}>
              MUSIC CUTS
            </button>
          </div>
          <div className="cp-seg" role="radiogroup" aria-label="On release, the echo">
            <button role="radio" aria-checked={dub.release === 'ring'} className={dub.release === 'ring' ? 'on' : ''} onClick={() => dubSettings.update({ release: 'ring' })}>
              RINGS ON
            </button>
            <button role="radio" aria-checked={dub.release === 'fade'} className={dub.release === 'fade' ? 'on' : ''} onClick={() => dubSettings.update({ release: 'fade' })}>
              DIES FAST
            </button>
          </div>
        </div>
      </section>
      <section className="cp-sec cp-tape" aria-label="Tape echo">
        <span className="cp-lab">Tape echo · master</span>
        <EchoUnit />
      </section>
      {pro && (
        <section className="cp-sec" aria-label="AUX effects">
          <div className="cp-row">
            {pg.aux.map((a, i) => (
              <div key={i} className="cp-aux">
                <span className="cp-lab">AUX {i + 1}</span>
                <select value={a.fx} aria-label={'AUX ' + (i + 1) + ' effect'} onChange={(e) => plugin.updateAux(i, { fx: e.target.value as typeof a.fx })}>
                  {AUX_FX.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <Knob label="RETURN" value={a.ret} min={0} max={1} reset={0.7} format={pct} onChange={(v) => plugin.updateAux(i, { ret: v })} />
              </div>
            ))}
            <span style={{ flex: 1 }} />
            <button className="cp-b" onClick={() => ui.open('plugin')} title="Stem sends (Plugin tab)">
              STEM SENDS
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
