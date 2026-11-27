import { useRef, useState } from 'react'
import {
  DUB_PRESET_DRAG,
  ECHO_BEATS,
  FACTORY,
  PATCH_LIMITS,
  dubBox,
  type LfoShape,
  type NoiseColor,
  type Patch,
  type Voice,
} from '../engine/dubbox'
import { mixer } from '../engine/mixer'
import { SFX } from '../engine/soundsystem'
import { useStore } from '../store'
import { Knob } from './Knob'
import { useToastError } from './Toaster'

type Numeric = keyof typeof PATCH_LIMITS

const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const pct = (v: number): string => Math.round(v * 100) + '%'
const sec = (v: number): string => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s')
const semis = (v: number): string => (v > 0 ? '+' : '') + Math.round(v) + ' st'
const fromA = (v: number): string => semis(12 * Math.log2(v / 440))

const LOG: Numeric[] = ['pitch', 'tone', 'lfoRate', 'echoTone', 'sweepTime', 'attack', 'release']
const LS_PAGE = 'vx_dbx_page'

type Page = 'sound' | 'shape' | 'echo' | 'channel'
const PAGES: { id: Page; label: string }[] = [
  { id: 'sound', label: 'Sound' },
  { id: 'shape', label: 'Shape' },
  { id: 'echo', label: 'Echo & spring' },
  { id: 'channel', label: 'Channel' },
]

/**
 * One control as a knob, with its value always written under it. Frequencies and times turn on a
 * logarithmic scale so the low end is usable; double-click puts it back to the factory sound's value.
 */
function Slider({ k, label, show, hint }: { k: Numeric; label: string; show: (v: number) => string; hint?: string }) {
  const value = useStore(dubBox).patch[k]
  const [lo, hi] = PATCH_LIMITS[k]
  const log = LOG.includes(k)
  const toPos = (v: number) => (log ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo))
  const fromPos = (t: number) => (log ? lo * Math.pow(hi / lo, t) : lo + t * (hi - lo))
  return (
    <div className="dbp-knob" title={hint}>
      <Knob
        label={label.toUpperCase()}
        value={toPos(value)}
        min={0}
        max={1}
        reset={toPos(FACTORY[0].patch[k] as number)}
        format={(t) => show(fromPos(t))}
        onChange={(t) => dubBox.updatePatch({ [k]: fromPos(t) })}
      />
      <output>{show(value)}</output>
    </div>
  )
}

function Pick<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange(v: T): void
}) {
  return (
    <label className="pick">
      <span>{label}</span>
      <select value={String(value)} onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}>
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Check({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange(v: boolean): void
  disabled?: boolean
}) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

/** A button that plays while held (pointer captured, so sliding off does not leave it stuck). */
function HoldButton({
  className,
  on,
  label,
  title,
  press,
}: {
  className: string
  on: boolean
  label: string
  title?: string
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

const VOICES: { value: Voice; label: string; hint: string }[] = [
  { value: 'siren', label: 'Siren', hint: 'Oscillator with pitch modulation: the classic siren' },
  { value: 'noise', label: 'Noise', hint: 'Filtered noise: whoosh, wind, thunder' },
  { value: 'spring', label: 'Spring', hint: 'A hit on the spring reverb: the dub crash' },
  { value: 'sample', label: 'Sample', hint: 'Your own sound or one of the app sounds, played with pitch, modulation and echo' },
]

const WAVES: { value: OscillatorType; label: string }[] = [
  { value: 'square', label: 'Square' },
  { value: 'sawtooth', label: 'Saw' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sine', label: 'Sine' },
]

const COLORS: { value: NoiseColor; label: string }[] = [
  { value: 'white', label: 'White (bright)' },
  { value: 'pink', label: 'Pink (balanced)' },
  { value: 'brown', label: 'Brown (deep)' },
]

const SHAPES: { value: LfoShape; label: string }[] = [
  { value: 'triangle', label: 'Up & down' },
  { value: 'sine', label: 'Smooth' },
  { value: 'sawtooth', label: 'Ramp up' },
  { value: 'square', label: 'Steps' },
  { value: 'random', label: 'Random' },
]

const beatLabel = (b: number): string => ({ 0.25: '¼', 0.5: '½', 0.75: '¾', 1.5: '1½' })[b] ?? String(b)

/**
 * Full settings of the Dub Box channel, on one screen: sounds on the left, the sound being
 * edited in the middle (one page of settings at a time), quick buttons and saving on the right.
 */
export function DubBoxPanel() {
  const d = useStore(dubBox)
  const hp = useStore(mixer).hpDevice
  const p = d.patch
  const [name, setName] = useState('')
  const [page, setPage] = useState<Page>(() => {
    try {
      const saved = localStorage.getItem(LS_PAGE) as Page | null
      return PAGES.some((x) => x.id === saved) ? saved! : 'sound'
    } catch {
      return 'sound'
    }
  })
  const [over, setOver] = useState(false)
  const [failed, setFailed] = useState(false)
  useToastError('dubbox-file', 'Dub Box', failed && "Couldn't read that audio file.")
  const picker = useRef<HTMLInputElement>(null)
  const set = (change: Partial<Patch>) => dubBox.updatePatch(change)
  const open = (next: Page) => {
    setPage(next)
    try {
      localStorage.setItem(LS_PAGE, next)
    } catch {
      /* not remembered */
    }
  }
  const loadFile = async (file: File | undefined) => {
    if (file) setFailed(!(await dubBox.loadSampleFile(file)))
  }
  const siren = p.voice === 'siren'
  const sample = p.voice === 'sample'
  const target = siren || sample ? 'the pitch' : 'the filter'
  const sfxValue = p.sample?.startsWith('sfx:') ? p.sample.slice(4) : ''
  const current = d.preset ?? (sample && p.sampleName ? p.sampleName : (d.basePreset ?? 'Sound') + ' (edited)')

  return (
    <div
      className={'dubbox-panel dbp' + (over ? ' over' : '')}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false)
      }}
      onDrop={(e) => {
        setOver(false)
        if (!e.dataTransfer.files[0]) return
        e.preventDefault()
        e.stopPropagation()
        void loadFile(e.dataTransfer.files[0])
      }}
    >
      <nav className="side-nav dbp-presets" aria-label="Dub Box sounds">
        <h5>Sounds</h5>
        {FACTORY.map((x) => (
          <button
            key={x.name}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(DUB_PRESET_DRAG, x.name)}
            className={'side-item' + (d.preset === x.name ? ' active' : '')}
            aria-pressed={d.preset === x.name}
            title="Click to use. Drag onto a quick pad (1 to 4)"
            onClick={() => dubBox.usePreset(x.name)}
          >
            {x.name}
          </button>
        ))}
        {d.user.length > 0 && <h5>Yours</h5>}
        {d.user.map((x) => (
          <div
            key={x.name}
            className={'side-item mine' + (d.preset === x.name ? ' active' : '')}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(DUB_PRESET_DRAG, x.name)}
          >
            <button onClick={() => dubBox.usePreset(x.name)} aria-pressed={d.preset === x.name}>
              {x.name}
            </button>
            <button className="x" aria-label={'Delete ' + x.name} title="Delete this sound" onClick={() => dubBox.deletePreset(x.name)}>
              ×
            </button>
          </div>
        ))}
      </nav>

      <section className="dbp-main" aria-label="Sound being edited">
        <div className="dbp-top">
          <HoldButton className="dbx-fire big" on={d.playing} label="FIRE" press={(down) => dubBox.fire(down)} />
          <HoldButton
            className="dbx-throw big"
            on={d.throwing}
            label="FX"
            title="FX: hold to throw everything into the Dub Box echo. Release: only the tail is left"
            press={(down) => dubBox.throw(down)}
          />
          <strong className="dbp-name" title="The sound FIRE plays now">
            {current}
          </strong>
          <div className="seg" role="radiogroup" aria-label="Voice">
            {VOICES.map((v) => (
              <button
                key={v.value}
                role="radio"
                aria-checked={p.voice === v.value}
                className={p.voice === v.value ? 'on' : ''}
                title={v.hint}
                onClick={() => set({ voice: v.value })}
              >
                {v.label}
              </button>
            ))}
          </div>
          <span className="dbx-tools">
            <button
              className="btn small"
              onClick={() => dubBox.surprise()}
              title="A random take on this voice, within values that sound good"
            >
              Surprise
            </button>
            <button
              className="btn small"
              disabled={d.preset !== null || !d.basePreset}
              onClick={() => dubBox.resetToPreset()}
              title={d.basePreset ? 'Back to ' + d.basePreset : ''}
            >
              Reset
            </button>
            <button
              className={'btn small' + (d.rehearse ? ' rehearse-on' : '')}
              aria-pressed={d.rehearse}
              disabled={!hp && !d.rehearse}
              onClick={() => dubBox.setRehearse(!d.rehearse)}
              title={
                hp ? 'Hear the Dub Box in the headphones only, not on the floor' : 'Pick the headphone output in Settings › Audio'
              }
            >
              {d.rehearse ? 'Rehearsing' : 'Rehearse'}
            </button>
          </span>
        </div>

        {sample && (
          <div className="dbx-sample">
            <strong>{p.sampleName || 'No sound picked'}</strong>
            <select value={sfxValue} aria-label="App sounds" onChange={(e) => e.target.value && void dubBox.useSfx(e.target.value)}>
              <option value="">{sfxValue ? '' : 'App sounds…'}</option>
              {SFX.filter((x) => x.id !== 'siren').map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              onClick={() => picker.current?.click()}
              title="You can also drop a file here or on the Dub Box in the mixer"
            >
              Your file…
            </button>
            <input ref={picker} type="file" accept="audio/*" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
          </div>
        )}

        <div className="sub-tabs" role="tablist" aria-label="Sound settings">
          {PAGES.map((x) => (
            <button key={x.id} role="tab" aria-selected={page === x.id} className={page === x.id ? 'on' : ''} onClick={() => open(x.id)}>
              {x.label}
            </button>
          ))}
        </div>

        <div className="rw-grid" role="tabpanel">
          {page === 'sound' && (
            <>
              {siren && <Pick label="Wave" value={p.wave} options={WAVES} onChange={(wave) => set({ wave })} />}
              {(p.voice === 'noise' || p.voice === 'spring') && (
                <Pick label="Noise" value={p.color} options={COLORS} onChange={(color) => set({ color })} />
              )}
              <Slider
                k="pitch"
                label={siren || sample ? 'Pitch' : p.voice === 'noise' ? 'Filter' : 'Spring pitch'}
                show={sample ? fromA : hz}
                hint={sample ? 'Sample tuning in semitones (0 = original; also changes speed)' : undefined}
              />
              <Slider
                k="lfoRate"
                label="LFO rate"
                show={(v) => v.toFixed(v < 1 ? 2 : 1) + ' Hz'}
                hint={'How many times per second it moves ' + target}
              />
              <Slider k="lfoDepth" label="LFO depth" show={semis} hint={'How far it moves ' + target + ', in semitones'} />
              <Slider k="echo" label="Echo send" show={pct} hint="How much of the sound goes into the echo. The echo is always on: each FIRE leaves this much tail" />
              {sample && <Check label="Loop while held" checked={p.loop} onChange={(loop) => set({ loop })} />}
              {sample && <Check label="Reverse" checked={p.reverse} onChange={(reverse) => set({ reverse })} />}
            </>
          )}
          {page === 'shape' && (
            <>
              {!siren && !sample && (
                <Slider k="resonance" label="Resonance" show={(v) => v.toFixed(1) + ' dB'} hint="Filter whistle" />
              )}
              {sample && <Slider k="start" label="Start" show={pct} hint="Where in the sample it starts" />}
              <Slider k="tone" label="Tone" show={hz} hint="Cuts the highs of the voice" />
              {p.voice !== 'spring' && <Slider k="attack" label="Attack" show={sec} hint="How long it takes to come in" />}
              <Slider k="release" label={p.voice === 'spring' ? 'Length' : 'Release'} show={sec} hint="How long it takes to fade out" />
              <Pick label="LFO shape" value={p.lfoShape} options={SHAPES} onChange={(lfoShape) => set({ lfoShape })} />
              <Slider k="sweep" label="Sweep" show={semis} hint={'On each FIRE ' + target + ' rises (+) or falls (−) this much'} />
              <Slider k="sweepTime" label="Sweep time" show={sec} hint="How long the sweep takes" />
            </>
          )}
          {page === 'echo' && (
            <>
              <Pick
                label="Echo time"
                value={p.echoBeats}
                options={ECHO_BEATS.map((b) => ({ value: b, label: beatLabel(b) + (b > 1 ? ' beats' : ' beat') }))}
                onChange={(echoBeats) => set({ echoBeats })}
              />
              <Slider k="feedback" label="Feedback" show={pct} hint="How many repeats" />
              <Slider k="echoTone" label="Echo tone" show={hz} hint="Each repeat gets darker at this frequency" />
              <Slider k="spring" label="Spring" show={pct} hint="Spring reverb on the whole channel" />
            </>
          )}
          {page === 'channel' && (
            <>
              <Pick
                label="FIRE button"
                value={d.mode}
                options={[
                  { value: 'hold', label: 'Hold (plays while pressed)' },
                  { value: 'latch', label: 'Latch (tap on, tap off)' },
                ]}
                onChange={(mode) => dubBox.setMode(mode)}
              />
              <Check label="Siren follows the key of the playing track" checked={d.followKey} onChange={(v) => dubBox.setFollowKey(v)} />
              <Check label="Sampler pads go through this channel" checked={d.sampler} onChange={(v) => dubBox.setSampler(v)} />
            </>
          )}
        </div>
      </section>

      <aside className="dbp-side" aria-label="Quick pads and save">
        <h5 title="Pads 1 to 4 in the mixer play the saved sound without changing what you are editing. You can also drag a sound from the list here.">
          Quick pads
        </h5>
        {d.slots.map((slot, i) => (
          <div
            key={i}
            className="dbx-slot-row"
            onDragOver={(e) => e.dataTransfer.types.includes(DUB_PRESET_DRAG) && e.preventDefault()}
            onDrop={(e) => {
              const preset = e.dataTransfer.getData(DUB_PRESET_DRAG)
              if (preset) dubBox.assignSlotPreset(i, preset)
            }}
          >
            <button
              className="num"
              disabled={!slot}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                dubBox.fireSlot(i, true)
              }}
              onPointerUp={() => dubBox.fireSlot(i, false)}
              onPointerCancel={() => dubBox.fireSlot(i, false)}
              title={slot ? 'Play ' + slot.name : 'Empty'}
            >
              {i + 1}
            </button>
            <span className="name">{slot ? slot.name : '—'}</span>
            <button
              className="row-btn show"
              onClick={() => dubBox.assignSlot(i)}
              title="Save the current sound on this pad"
              aria-label={'Save the current sound on pad ' + (i + 1)}
            >
              ↓
            </button>
            <button
              className="row-btn show x"
              disabled={!slot}
              onClick={() => dubBox.clearSlot(i)}
              aria-label={'Clear pad ' + (i + 1)}
            >
              ×
            </button>
          </div>
        ))}
        <form
          className="dbx-save"
          onSubmit={(e) => {
            e.preventDefault()
            dubBox.savePreset(name)
            setName('')
          }}
        >
          <input
            value={name}
            maxLength={30}
            placeholder="Name your sound"
            aria-label="Name of the sound to save"
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn small" disabled={!name.trim() || FACTORY.some((x) => x.name === name.trim())}>
            Save
          </button>
        </form>
      </aside>
    </div>
  )
}
