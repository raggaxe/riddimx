import { useState } from 'react'
import { useStore } from '../store'
import { ui } from '../ui'
import { Knob } from './Knob'
import { DubSoundMenu } from './DubSoundMenu'
import { SoundPads } from './MixerView'
import { EchoUnit } from './Rack'
import { VoicePanel } from './VoicePanel'
import { deckA, deckB, type Deck } from '../engine/deck'
import { dubBox, FACTORY, PATCH_LIMITS } from '../engine/dubbox'
import { outboard } from '../engine/outboard'
import { DUB_BEATS, DUB_LIMITS, DUB_PRESETS, dubSettings } from '../engine/dub'
import { FX, type FxType } from '../engine/fx'
import { AUX_FX, plugin } from '../engine/plugin'
import { STEMS, type Stem } from '../engine/stems'

const pct = (v: number): string => Math.round(v * 100) + '%'
const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const toLog = (v: number, lo: number, hi: number): number => Math.log(v / lo) / Math.log(hi / lo)
const fromLog = (t: number, lo: number, hi: number): number => lo * Math.pow(hi / lo, t)
const filterText = (v: number): string =>
  Math.abs(v) < 0.04 ? 'OFF' : v < 0 ? 'LP ' + Math.round(-v * 100) + '%' : 'HP ' + Math.round(v * 100) + '%'

const FX_LABEL: Record<FxType, string> = { echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGE', wah: 'WAH' }

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
function Hold({
  className,
  on,
  label,
  title,
  press,
}: {
  className: string
  on: boolean
  label: string
  title: string
  press(down: boolean): void
}) {
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
            <button
              className="cp-b"
              onClick={() => dubBox.surprise()}
              title="A random take on this sound, within values that sound good"
            >
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
          <Knob
            label="ECHO"
            value={p.echo}
            min={0}
            max={1}
            reset={0.5}
            format={pct}
            onChange={(v) => dubBox.updatePatch({ echo: v })}
          />
          <Knob label="FILTER" value={d.filter} format={filterText} onChange={(v) => dubBox.setFilter(v)} />
          <Knob label="LEVEL" value={d.level} min={0} max={1} reset={0.8} format={pct} onChange={(v) => dubBox.setLevel(v)} />
        </div>
      )}

      <div className="cp-seg" role="radiogroup" aria-label="Pads show">
        <button
          role="radio"
          aria-checked={!sounds}
          className={!sounds ? 'on' : ''}
          onClick={() => setSounds(false)}
          title="Pads play the Dub Box sounds"
        >
          SOUNDS
        </button>
        <button
          role="radio"
          aria-checked={sounds}
          className={sounds ? 'on' : ''}
          onClick={() => setSounds(true)}
          title="Pads play the sampler"
        >
          SAMPLER
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
              title={
                slot
                  ? 'Quick pad ' + (i + 1) + ': ' + slot.name
                  : 'Quick pad ' + (i + 1) + ': empty (save a sound in the Dub Box tab)'
              }
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
        <div
          className="cp-seg"
          role="radiogroup"
          aria-label="FIRE button"
          title="FIRE button: HOLD sounds while held, LATCH stays on until pressed again"
        >
          <button
            role="radio"
            aria-checked={d.mode === 'hold'}
            className={d.mode === 'hold' ? 'on' : ''}
            onClick={() => dubBox.setMode('hold')}
          >
            HOLD
          </button>
          <button
            role="radio"
            aria-checked={d.mode === 'latch'}
            className={d.mode === 'latch' ? 'on' : ''}
            onClick={() => dubBox.setMode('latch')}
          >
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
            title={fx === 'flanger' ? 'Flanger' : undefined}
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
          label="THROW"
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

/** FX page: each deck's effect and THROW and, in Pro, the two AUX effects fed by the stems. */
export function FxPage() {
  return <EffectsPage part="fx" />
}

/** DECK DUB page: the echo of the decks' DUB button. */
export function EchoPage() {
  return <EffectsPage part="echo" />
}

/** TAPE page: the tape echo on the master. */
export function TapePage() {
  return <EffectsPage part="tape" />
}

/** The effects, split over three pages so none of them has to scroll. */
function EffectsPage({ part }: { part: 'fx' | 'echo' | 'tape' }) {
  const dub = useStore(dubSettings)
  const pro = useStore(ui).mode === 'pro'
  return (
    <div className={'cp cp-fx cp-part-' + part}>
      {part === 'fx' && (
        <div className="cp-two">
          <DeckFx deck={deckA} />
          <DeckFx deck={deckB} />
        </div>
      )}
      {part === 'fx' && pro && <AuxBands />}
      {part === 'echo' && (
        <section className="cp-sec" aria-label="Deck DUB button">
          <div className="cp-row">
            <span className="cp-lab" style={{ flex: 1 }}>
              Deck DUB button · both decks
            </span>
            <button
              className="cp-b"
              onClick={() => dubSettings.update({ ...DUB_PRESETS[0].settings })}
              title="Back to the Classic DUB"
            >
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
                <button
                  key={pr.name}
                  role="radio"
                  aria-checked={on}
                  className={on ? 'on' : ''}
                  onClick={() => dubSettings.update({ ...pr.settings })}
                >
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
            <Knob
              label="SPRING"
              value={dub.space}
              min={0}
              max={1}
              reset={0}
              format={pct}
              onChange={(v) => dubSettings.update({ space: v })}
            />
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
              <button
                role="radio"
                aria-checked={dub.mode === 'hold'}
                className={dub.mode === 'hold' ? 'on' : ''}
                onClick={() => dubSettings.update({ mode: 'hold' })}
              >
                HOLD
              </button>
              <button
                role="radio"
                aria-checked={dub.mode === 'latch'}
                className={dub.mode === 'latch' ? 'on' : ''}
                onClick={() => dubSettings.update({ mode: 'latch' })}
              >
                LATCH
              </button>
            </div>
            <div className="cp-seg" role="radiogroup" aria-label="While DUB is held, the music">
              <button
                role="radio"
                aria-checked={dub.dry === 'keep'}
                className={dub.dry === 'keep' ? 'on' : ''}
                onClick={() => dubSettings.update({ dry: 'keep' })}
              >
                MUSIC KEEPS
              </button>
              <button
                role="radio"
                aria-checked={dub.dry === 'cut'}
                className={dub.dry === 'cut' ? 'on' : ''}
                onClick={() => dubSettings.update({ dry: 'cut' })}
              >
                MUSIC CUTS
              </button>
            </div>
            <div className="cp-seg" role="radiogroup" aria-label="On release, the echo">
              <button
                role="radio"
                aria-checked={dub.release === 'ring'}
                className={dub.release === 'ring' ? 'on' : ''}
                onClick={() => dubSettings.update({ release: 'ring' })}
              >
                RINGS ON
              </button>
              <button
                role="radio"
                aria-checked={dub.release === 'fade'}
                className={dub.release === 'fade' ? 'on' : ''}
                onClick={() => dubSettings.update({ release: 'fade' })}
              >
                DIES FAST
              </button>
            </div>
          </div>
        </section>
      )}
      {part === 'tape' && (
        <section className="cp-sec cp-tape" aria-label="Tape echo">
          <span className="cp-lab">Tape echo · master</span>
          <EchoUnit />
        </section>
      )}
    </div>
  )
}

const STEM_SHORT: Record<Stem, string> = { vocal: 'VOC', instr: 'INST', bass: 'BASS', kick: 'KICK', hat: 'HATS' }

/**
 * The two AUX effects of the FX page. Each band: the effect and CLEAR on top, then one row of knobs —
 * the effect's two settings, its return LEVEL, and how much of each stem of deck A and deck B is sent
 * into it (after the deck's fader).
 */
function AuxBands() {
  const p = useStore(plugin)
  return (
    <>
      {p.aux.map((aux, i) => {
        const fx = AUX_FX.find((f) => f.id === aux.fx)!
        const sending = (['A', 'B'] as const).some((d) => STEMS.some((st) => p.send[i][d][st] > 0))
        return (
          <section key={i} className={'cp-sec cp-auxband' + (sending ? ' on' : '')} aria-label={'AUX ' + (i + 1)}>
            <div className="cp-row">
              <span className="cp-tag">AUX {i + 1}</span>
              <div className="cp-seg" role="radiogroup" aria-label={'AUX ' + (i + 1) + ' effect'}>
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
              <span style={{ flex: 1 }} />
              <button
                className="cp-b"
                disabled={!sending}
                onClick={() => plugin.clearSends(i)}
                title="Every send of this AUX back to zero"
              >
                CLEAR
              </button>
            </div>
            <div className="cp-auxknobs">
              <div className="cp-auxgroup">
                <Knob
                  label={fx.a}
                  value={aux.a}
                  min={0}
                  max={1}
                  reset={0.5}
                  format={pct}
                  onChange={(v) => plugin.updateAux(i, { a: v })}
                />
                <Knob
                  label={fx.b}
                  value={aux.b}
                  min={0}
                  max={1}
                  reset={0.5}
                  format={pct}
                  onChange={(v) => plugin.updateAux(i, { b: v })}
                />
                <Knob
                  label="LEVEL"
                  value={aux.ret}
                  min={0}
                  max={1}
                  reset={0.7}
                  format={pct}
                  onChange={(v) => plugin.updateAux(i, { ret: v })}
                />
              </div>
              {(['A', 'B'] as const).map((d) => (
                <div
                  key={d}
                  className={'cp-auxgroup sends ' + d.toLowerCase()}
                  title={'Stems of deck ' + d + ' sent into AUX ' + (i + 1)}
                >
                  <em>{d}</em>
                  {STEMS.map((st) => (
                    <Knob
                      key={st}
                      label={STEM_SHORT[st]}
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
          </section>
        )
      })}
    </>
  )
}

/**
 * One side of the FX page (deck A on the left of the master, deck B on the right): the deck's own
 * effect and THROW, then — in Pro — how much of each of its stems goes into AUX 1 and AUX 2. The AUX
 * effects themselves are shared by both decks: their "⋯" opens the FX tab below, where they are set.
 */
export function FxSide({ deck }: { deck: Deck }) {
  const p = useStore(plugin)
  const pro = useStore(ui).mode === 'pro'
  const d = deck.name as 'A' | 'B'
  return (
    <div className={'cp cp-fxside ' + d.toLowerCase()}>
      <DeckFx deck={deck} />
      {pro &&
        p.aux.map((aux, i) => {
          const fx = AUX_FX.find((f) => f.id === aux.fx)!
          return (
            <section key={i} className="cp-sec cp-sendrow" aria-label={'Deck ' + d + ' stems into AUX ' + (i + 1)}>
              <div className="cp-row">
                <span className="cp-lab">
                  AUX {i + 1} · {fx.label}
                </span>
                <span style={{ flex: 1 }} />
                <button
                  className="mx-sec-more"
                  onClick={() => ui.open('plugin')}
                  aria-label={'AUX ' + (i + 1) + ' effect and settings (FX tab, below)'}
                  title={'AUX ' + (i + 1) + ': effect, its settings and LEVEL (FX tab, below)'}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <circle cx="3" cy="8" r="1.6" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.6" fill="currentColor" />
                    <circle cx="13" cy="8" r="1.6" fill="currentColor" />
                  </svg>
                </button>
              </div>
              <div className="cp-sendknobs">
                {STEMS.map((st) => (
                  <Knob
                    key={st}
                    label={STEM_SHORT[st]}
                    value={p.send[i][d][st]}
                    min={0}
                    max={1}
                    reset={0}
                    format={pct}
                    onChange={(v) => plugin.setSend(i, d, st, v)}
                  />
                ))}
              </div>
            </section>
          )
        })}
    </div>
  )
}

/**
 * The shared AUX effects, in the middle of the FX page: each AUX's effect, its two settings and its
 * return LEVEL. They are one set for both decks, so they sit once, between A and B.
 */
export function AuxStrip() {
  const p = useStore(plugin)
  return (
    <div className="cp cp-auxstrip">
      {p.aux.map((aux, i) => {
        const fx = AUX_FX.find((f) => f.id === aux.fx)!
        return (
          <section key={i} className="cp-sec cp-auxcol" aria-label={'AUX ' + (i + 1)}>
            <div className="cp-seg" role="radiogroup" aria-label={'AUX ' + (i + 1) + ' effect'} title={'AUX ' + (i + 1)}>
              {AUX_FX.map((f) => (
                <button
                  key={f.id}
                  role="radio"
                  aria-checked={aux.fx === f.id}
                  className={aux.fx === f.id ? 'on' : ''}
                  title={f.hint}
                  onClick={() => plugin.updateAux(i, { fx: f.id })}
                >
                  {f.label.slice(0, 3)}
                </button>
              ))}
            </div>
            <div className="cp-auxknobs2">
              <Knob
                label={fx.a}
                value={aux.a}
                min={0}
                max={1}
                reset={0.5}
                format={pct}
                onChange={(v) => plugin.updateAux(i, { a: v })}
              />
              <Knob
                label={fx.b}
                value={aux.b}
                min={0}
                max={1}
                reset={0.5}
                format={pct}
                onChange={(v) => plugin.updateAux(i, { b: v })}
              />
              <Knob
                label="LEVEL"
                value={aux.ret}
                min={0}
                max={1}
                reset={0.7}
                format={pct}
                onChange={(v) => plugin.updateAux(i, { ret: v })}
              />
            </div>
            <button
              className="cp-b"
              disabled={!p.send[i]}
              onClick={() => plugin.clearSends(i)}
              title="Every send of this AUX back to zero"
            >
              CLEAR
            </button>
          </section>
        )
      })}
    </div>
  )
}

/** MIC page: the live mic of the Voice tab, in the centre (TALK, level, duck, presets, colour, echo, spring, output). */
export function MicPage() {
  return (
    <div className="cp cp-mic">
      <VoicePanel />
    </div>
  )
}
