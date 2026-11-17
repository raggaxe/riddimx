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

type Numeric = keyof typeof PATCH_LIMITS

const hz = (v: number): string => (v >= 1000 ? (v / 1000).toFixed(1) + ' kHz' : Math.round(v) + ' Hz')
const pct = (v: number): string => Math.round(v * 100) + '%'
const sec = (v: number): string => (v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s')
const semis = (v: number): string => (v > 0 ? '+' : '') + Math.round(v) + ' meios-tons'
const fromA = (v: number): string => semis(12 * Math.log2(v / 440))

const LOG: Numeric[] = ['pitch', 'tone', 'lfoRate', 'echoTone', 'sweepTime', 'attack', 'release']
const LS_PAGE = 'vx_dbx_page'

type Page = 'sound' | 'shape' | 'echo' | 'channel'
const PAGES: { id: Page; label: string }[] = [
  { id: 'sound', label: 'Som' },
  { id: 'shape', label: 'Forma' },
  { id: 'echo', label: 'Eco e mola' },
  { id: 'channel', label: 'Canal' },
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
  { value: 'siren', label: 'Sirene', hint: 'Oscilador com oscilação de tom: a sirene clássica' },
  { value: 'noise', label: 'Ruído', hint: 'Ruído filtrado: whoosh, vento, trovão' },
  { value: 'spring', label: 'Mola', hint: 'Pancada na reverb de mola: o crash do dub' },
  { value: 'sample', label: 'Sample', hint: 'Um som teu, ou um dos efeitos da app, tocado com tom, oscilação e eco' },
]

const WAVES: { value: OscillatorType; label: string }[] = [
  { value: 'square', label: 'Quadrada' },
  { value: 'sawtooth', label: 'Serra' },
  { value: 'triangle', label: 'Triângulo' },
  { value: 'sine', label: 'Seno' },
]

const COLORS: { value: NoiseColor; label: string }[] = [
  { value: 'white', label: 'Branco (brilhante)' },
  { value: 'pink', label: 'Rosa (equilibrado)' },
  { value: 'brown', label: 'Castanho (grave)' },
]

const SHAPES: { value: LfoShape; label: string }[] = [
  { value: 'triangle', label: 'Sobe e desce' },
  { value: 'sine', label: 'Suave' },
  { value: 'sawtooth', label: 'Só sobe' },
  { value: 'square', label: 'Degraus' },
  { value: 'random', label: 'Aleatória' },
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
  const target = siren || sample ? 'o tom' : 'o filtro'
  const sfxValue = p.sample?.startsWith('sfx:') ? p.sample.slice(4) : ''
  const current = d.preset ?? (sample && p.sampleName ? p.sampleName : (d.basePreset ?? 'Som') + ' (ajustado)')

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
      <nav className="side-nav dbp-presets" aria-label="Sons da Dub Box">
        <h5>Sons</h5>
        {FACTORY.map((x) => (
          <button
            key={x.name}
            draggable
            onDragStart={(e) => e.dataTransfer.setData(DUB_PRESET_DRAG, x.name)}
            className={'side-item' + (d.preset === x.name ? ' active' : '')}
            aria-pressed={d.preset === x.name}
            title="Clique: usar. Arrasta para um botão rápido (1 a 4)"
            onClick={() => dubBox.usePreset(x.name)}
          >
            {x.name}
          </button>
        ))}
        {d.user.length > 0 && <h5>Os teus</h5>}
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
            <button className="x" aria-label={'Apagar ' + x.name} title="Apagar este som" onClick={() => dubBox.deletePreset(x.name)}>
              ×
            </button>
          </div>
        ))}
      </nav>

      <section className="dbp-main" aria-label="Som em edição">
        <div className="dbp-top">
          <HoldButton className="dbx-fire big" on={d.playing} label="FIRE" press={(down) => dubBox.fire(down)} />
          <HoldButton
            className="dbx-throw big"
            on={d.throwing}
            label="ECO"
            title="Throw: manter premido atira tudo para o eco"
            press={(down) => dubBox.throw(down)}
          />
          <strong className="dbp-name" title="Som que o FIRE toca agora">
            {current}
          </strong>
          <div className="seg" role="radiogroup" aria-label="Voz">
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
              title="Uma variação aleatória desta voz, dentro de valores que soam bem"
            >
              Surpresa
            </button>
            <button
              className="btn small"
              disabled={d.preset !== null || !d.basePreset}
              onClick={() => dubBox.resetToPreset()}
              title={d.basePreset ? 'Voltar a ' + d.basePreset : ''}
            >
              Repor
            </button>
            <button
              className={'btn small' + (d.rehearse ? ' rehearse-on' : '')}
              aria-pressed={d.rehearse}
              disabled={!hp && !d.rehearse}
              onClick={() => dubBox.setRehearse(!d.rehearse)}
              title={
                hp ? 'Ouvir a Dub Box só nos auscultadores, sem sair para a pista' : 'Escolhe a saída dos auscultadores no separador Áudio'
              }
            >
              {d.rehearse ? 'A ensaiar' : 'Ensaiar'}
            </button>
          </span>
        </div>

        {sample && (
          <div className="dbx-sample">
            <strong>{p.sampleName || 'Sem som escolhido'}</strong>
            <select value={sfxValue} aria-label="Efeitos da app" onChange={(e) => e.target.value && void dubBox.useSfx(e.target.value)}>
              <option value="">{sfxValue ? '' : 'Efeitos da app…'}</option>
              {SFX.filter((x) => x.id !== 'siren').map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
            <button
              className="btn small"
              onClick={() => picker.current?.click()}
              title="Também podes arrastar um ficheiro para aqui ou para a Dub Box no mixer"
            >
              Ficheiro teu…
            </button>
            {failed && <span className="deck-msg error">Não consegui ler esse ficheiro de áudio.</span>}
            <input ref={picker} type="file" accept="audio/*" hidden onChange={(e) => void loadFile(e.target.files?.[0])} />
          </div>
        )}

        <div className="sub-tabs" role="tablist" aria-label="Ajustes do som">
          {PAGES.map((x) => (
            <button key={x.id} role="tab" aria-selected={page === x.id} className={page === x.id ? 'on' : ''} onClick={() => open(x.id)}>
              {x.label}
            </button>
          ))}
        </div>

        <div className="rw-grid" role="tabpanel">
          {page === 'sound' && (
            <>
              {siren && <Pick label="Onda" value={p.wave} options={WAVES} onChange={(wave) => set({ wave })} />}
              {(p.voice === 'noise' || p.voice === 'spring') && (
                <Pick label="Ruído" value={p.color} options={COLORS} onChange={(color) => set({ color })} />
              )}
              <Slider
                k="pitch"
                label={siren || sample ? 'Tom' : p.voice === 'noise' ? 'Filtro' : 'Tom da mola'}
                show={sample ? fromA : hz}
                hint={sample ? 'Afinação do sample, em semitons (0 = original; também muda a velocidade)' : undefined}
              />
              <Slider
                k="lfoRate"
                label="Oscilação"
                show={(v) => v.toFixed(v < 1 ? 2 : 1) + ' Hz'}
                hint={'Quantas vezes por segundo mexe ' + target}
              />
              <Slider k="lfoDepth" label="Profundidade" show={semis} hint={'Quanto mexe ' + target + ', em semitons'} />
              <Slider k="echo" label="Eco" show={pct} hint="Quanto do som vai para o eco" />
              {sample && <Check label="Repetir enquanto carregas" checked={p.loop} onChange={(loop) => set({ loop })} />}
              {sample && <Check label="Ao contrário" checked={p.reverse} onChange={(reverse) => set({ reverse })} />}
            </>
          )}
          {page === 'shape' && (
            <>
              {!siren && !sample && (
                <Slider k="resonance" label="Ressonância" show={(v) => v.toFixed(1) + ' dB'} hint="Assobio do filtro" />
              )}
              {sample && <Slider k="start" label="Começa em" show={pct} hint="Ponto do sample onde começa a tocar" />}
              <Slider k="tone" label="Brilho" show={hz} hint="Corta os agudos da voz" />
              {p.voice !== 'spring' && <Slider k="attack" label="Entrada" show={sec} hint="Quanto demora a aparecer" />}
              <Slider k="release" label={p.voice === 'spring' ? 'Duração' : 'Ao soltar'} show={sec} hint="Quanto demora a desaparecer" />
              <Pick label="Oscilação" value={p.lfoShape} options={SHAPES} onChange={(lfoShape) => set({ lfoShape })} />
              <Slider k="sweep" label="Varrimento" show={semis} hint={'Em cada disparo ' + target + ' sobe (+) ou desce (−) isto'} />
              <Slider k="sweepTime" label="Tempo varr." show={sec} hint="Tempo do varrimento" />
            </>
          )}
          {page === 'echo' && (
            <>
              <Pick
                label="Tempo do eco"
                value={p.echoBeats}
                options={ECHO_BEATS.map((b) => ({ value: b, label: beatLabel(b) + (b > 1 ? ' batidas' : ' batida') }))}
                onChange={(echoBeats) => set({ echoBeats })}
              />
              <Slider k="feedback" label="Repetições" show={pct} />
              <Slider k="echoTone" label="Brilho do eco" show={hz} />
              <Slider k="spring" label="Mola" show={pct} hint="Reverb de mola sobre todo o canal" />
            </>
          )}
          {page === 'channel' && (
            <>
              <Pick
                label="Botão FIRE"
                value={d.mode}
                options={[
                  { value: 'hold', label: 'Manter premido' },
                  { value: 'latch', label: 'Liga / desliga' },
                ]}
                onChange={(mode) => dubBox.setMode(mode)}
              />
              <Check label="Sirene no tom da música que toca" checked={d.followKey} onChange={(v) => dubBox.setFollowKey(v)} />
              <Check label="Pads do sampler passam por este canal" checked={d.sampler} onChange={(v) => dubBox.setSampler(v)} />
            </>
          )}
        </div>
      </section>

      <aside className="dbp-side" aria-label="Botões rápidos e guardar">
        <h5 title="Os botões 1 a 4 do mixer tocam o som guardado, sem mudar o que estás a editar. Também podes arrastar um som da lista para aqui.">
          Botões rápidos
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
              title={slot ? 'Tocar ' + slot.name : 'Vazio'}
            >
              {i + 1}
            </button>
            <span className="name">{slot ? slot.name : '—'}</span>
            <button
              className="row-btn show"
              onClick={() => dubBox.assignSlot(i)}
              title="Guardar o som atual neste botão"
              aria-label={'Guardar o som atual no botão ' + (i + 1)}
            >
              ↓
            </button>
            <button
              className="row-btn show x"
              disabled={!slot}
              onClick={() => dubBox.clearSlot(i)}
              aria-label={'Esvaziar botão ' + (i + 1)}
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
            placeholder="Nome do teu som"
            aria-label="Nome do som a guardar"
            onChange={(e) => setName(e.target.value)}
          />
          <button className="btn small" disabled={!name.trim() || FACTORY.some((x) => x.name === name.trim())}>
            Guardar
          </button>
        </form>
      </aside>
    </div>
  )
}
