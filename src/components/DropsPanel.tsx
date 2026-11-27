import { useEffect, useRef, useState } from 'react'
import { myDrops } from '../engine/mydrops'
import {
  MicTake,
  STYLES,
  SUGGESTIONS,
  canSpeak,
  render,
  speak,
  toWav,
  voices,
  type DropOptions,
  type Voice,
} from '../engine/drops'
import { sampler } from '../engine/sampler'
import { SFX } from '../engine/soundsystem'
import { useStore } from '../store'
import { Knob } from './Knob'
import { ClipPicker } from './ClipPicker'
import { useToastError } from './Toaster'

const pct = (v: number) => Math.round(v * 100) + '%'

const LS = 'vx_drops'
type Source = 'mac' | 'mic' | 'track'
interface Saved {
  text: string
  source: Source
  voice: string
  rate: number
  options: DropOptions
}

const DEFAULTS: Saved = {
  text: 'RiddimX sound!',
  source: 'mac',
  voice: '',
  rate: 175,
  options: { style: 'mc', ...STYLES[0].set, sfx: 'airhorn', sfxAt: 'end' },
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(LS) || '{}')
    // Options saved before the knobs existed take their style's values for the new ones.
    const style = STYLES.find((x) => x.id === s.options?.style) ?? STYLES[0]
    return { ...DEFAULTS, ...s, options: { ...DEFAULTS.options, ...style.set, ...(s.options ?? {}) } }
  } catch {
    return DEFAULTS
  }
}

/**
 * Apple's novelty voices (Eddy, Flo, Grandma…) exist in every language but sound robotic, and their
 * Portuguese sounds European even when labelled Brazil: they go to their own group at the end.
 */
const ROBOTIC = /^(Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley)\b/
const natural = (v: Voice) => !ROBOTIC.test(v.name)

/** Voice list groups, Brazilian Portuguese first. */
const GROUPS: [string, (v: Voice) => boolean][] = [
  ['Portuguese (Brazil)', (v) => v.lang === 'pt_BR' && natural(v)],
  ['English', (v) => v.lang.startsWith('en') && natural(v)],
  ['Spanish', (v) => v.lang.startsWith('es') && natural(v)],
  ['French', (v) => v.lang.startsWith('fr') && natural(v)],
  ['Italian', (v) => v.lang.startsWith('it') && natural(v)],
  ['Portuguese (Portugal)', (v) => v.lang === 'pt_PT'],
  ['Robotic', (v) => !natural(v)],
]

/** Best Brazilian voice the Mac has: Luciana, else any pt_BR. */
const brazilian = (v: Voice[]) => v.find((x) => x.name.startsWith('Luciana')) ?? v.find((x) => x.lang === 'pt_BR' && natural(x))

/** Small picture of the drop, so you see the voice and its echo tail. */
function Shape({ buffer }: { buffer: AudioBuffer | null }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const w = (c.width = c.clientWidth * devicePixelRatio)
    const h = (c.height = c.clientHeight * devicePixelRatio)
    const g = c.getContext('2d')!
    g.clearRect(0, 0, w, h)
    if (!buffer) return
    const d = buffer.getChannelData(0)
    const step = Math.max(1, Math.floor(d.length / w))
    g.fillStyle = '#d9d3c7'
    for (let x = 0; x < w; x++) {
      let peak = 0
      for (let i = x * step; i < (x + 1) * step && i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
      const bar = Math.max(1, peak * h * 0.95)
      g.fillRect(x, (h - bar) / 2, 1, bar)
    }
  }, [buffer])
  return <canvas ref={canvas} className="dr-shape" aria-hidden="true" />
}

/**
 * Drop maker: a line of text in one of the Mac's voices, or your own voice from the microphone,
 * shaped into a sound-system drop (MC, dub echo, giant, megaphone…) and put on a sampler pad.
 */
export function DropsPanel() {
  const pads = useStore(sampler).pads
  const [saved, setSaved] = useState(load)
  const { text, source, voice, rate, options } = saved
  const [list, setList] = useState<Voice[]>([])
  const [raw, setRaw] = useState<AudioBuffer | null>(null) // the voice before the style
  const [drop, setDrop] = useState<AudioBuffer | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useToastError('drops', 'Drops', error)
  const [playing, setPlaying] = useState(false)
  const [recording, setRecording] = useState(false)
  const [pad, setPad] = useState(() =>
    Math.max(
      0,
      pads.findIndex((p) => !p.name),
    ),
  )
  const [placed, setPlaced] = useState<number | null>(null)
  const take = useRef<MicTake | null>(null)
  const spoken = useRef('') // text|voice|rate of the voice in `raw`
  const clipName = useRef('') // the track a cut came from

  const update = (change: Partial<Saved>) => {
    const next = { ...saved, ...change }
    setSaved(next)
    try {
      localStorage.setItem(LS, JSON.stringify(next))
    } catch {
      /* not remembered */
    }
  }
  const [listen, setListen] = useState(true) // play the drop again after each change
  const heardChange = useRef(false)
  const setOptions = (change: Partial<DropOptions>) => {
    heardChange.current = listen
    update({ options: { ...options, ...change } })
  }

  useEffect(() => {
    void voices().then((v) => {
      setList(v)
      // Portuguese means Brazilian here: a missing voice, Portugal's, or a robotic "Brazilian" one
      // (they sound European) becomes the real Brazilian voice.
      const current = v.find((x) => x.name === voice)
      if ((!current || current.lang === 'pt_PT' || (current.lang === 'pt_BR' && !natural(current))) && v.length) {
        const pick = brazilian(v) ?? v.find((x) => x.lang.startsWith('en')) ?? v[0]
        update({ voice: pick.name })
      }
    })
    return () => {
      take.current?.cancel()
      sampler.stopPreview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The style is applied again on every change, so turning a knob is heard right away.
  useEffect(() => {
    if (!raw) return
    let stale = false
    const timer = window.setTimeout(async () => {
      try {
        const next = await render(raw, options)
        if (!stale) {
          setDrop(next)
          setPlaced(null)
          // Turning a knob plays the result, so the change is heard without pressing play.
          if (heardChange.current) {
            heardChange.current = false
            play(next)
          }
        }
      } catch {
        if (!stale) setError("Couldn't apply the style.")
      }
    }, 260)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [raw, options])

  const play = (buffer: AudioBuffer | null = drop) => {
    if (!buffer) return
    setPlaying(true)
    sampler.previewBuffer(buffer, () => setPlaying(false))
  }

  /** Speak the text (only when text, voice or speed changed), then play the result. */
  const make = async () => {
    setError(null)
    if (source === 'mic') return
    const key = text + '|' + voice + '|' + rate
    if (raw && spoken.current === key && drop) return play()
    setBusy('Making the voice…')
    try {
      const v = await speak(text, voice, rate)
      spoken.current = key
      setRaw(v)
      const out = await render(v, options)
      setDrop(out)
      setPlaced(null)
      play(out)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const record = async () => {
    setError(null)
    if (recording) {
      setRecording(false)
      try {
        const v = await take.current!.stop()
        spoken.current = ''
        setRaw(v)
        const out = await render(v, options)
        setDrop(out)
        setPlaced(null)
        play(out)
      } catch (e) {
        setError((e as Error).message)
      }
      return
    }
    try {
      sampler.stopPreview()
      take.current = new MicTake()
      await take.current.start()
      setRecording(true)
    } catch {
      setError('No access to the microphone. Allow it in Mac System Settings, under Privacy.')
    }
  }

  const name = (text.trim() || 'Drop').replace(/[!?.,]+$/, '').slice(0, 24)

  const mine = useStore(myDrops).list
  const [kept, setKept] = useState<AudioBuffer | null>(null) // the drop last saved to My drops
  const label = source === 'mic' ? 'My voice' : source === 'track' ? 'Cut ' + clipName.current.slice(0, 20) : name

  const keep = async (buffer: AudioBuffer, as: string) => {
    if (await myDrops.save(as, buffer)) setKept(buffer)
    else setError("Couldn't save the drop in the app.")
  }

  // Every drop that goes on a pad is also kept in My drops.
  const place = async () => {
    if (!drop) return
    const ok = await sampler.load(pad, new File([toWav(drop)], label + '.wav', { type: 'audio/wav' }))
    if (ok) {
      setPlaced(pad)
      void keep(drop, dropName.trim() || label)
    } else setError("The pad didn't take the sound.")
  }

  const exportWav = (wav: Uint8Array<ArrayBuffer>, as: string) => {
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }))
    link.download = 'Drop ' + as + '.wav'
    link.click()
    window.setTimeout(() => URL.revokeObjectURL(link.href), 30000)
  }

  const [hearing, setHearing] = useState<string | null>(null)
  const hear = async (id: string) => {
    if (hearing === id) {
      sampler.stopPreview()
      return
    }
    const buffer = await myDrops.buffer(id)
    if (!buffer) return
    setHearing(id)
    sampler.previewBuffer(buffer, () => setHearing((h) => (h === id ? null : h)))
  }
  const [renaming, setRenaming] = useState<string | null>(null)
  const [dropName, setDropName] = useState('')
  const [placedOn, setPlacedOn] = useState<Record<string, number>>({})
  const toPad = async (d: { id: string; name: string }, index: number) => {
    const wav = await myDrops.wav(d.id)
    if (!wav) return
    const ok = await sampler.load(index, new File([wav.slice()], d.name + '.wav', { type: 'audio/wav' }))
    if (ok) setPlacedOn((m) => ({ ...m, [d.id]: index }))
    else setError("The pad didn't take the sound.")
  }

  const style = STYLES.find((x) => x.id === options.style) ?? STYLES[0]
  const groups = GROUPS.map(([label, test]) => [label, list.filter(test)] as const).filter(([, vs]) => vs.length)

  const ready = raw && spoken.current === text + '|' + voice + '|' + rate
  return (
    <div className="dr dr2">
      {/* 1 · SAY IT: what is said and by whom, and the button that makes it and plays it */}
      <section className="dr-col dr-step" aria-label="1. Say it">
        <h4 className="dr-step-title">
          <b>1</b> Say it
        </h4>
        <div className="dr-source" role="group" aria-label="Where the voice comes from">
          <button
            className={source === 'mac' ? 'now' : ''}
            aria-pressed={source === 'mac'}
            onClick={() => update({ source: 'mac' })}
            title="Type it and a Mac voice says it"
          >
            Type
          </button>
          <button
            className={source === 'mic' ? 'now' : ''}
            aria-pressed={source === 'mic'}
            onClick={() => update({ source: 'mic' })}
            title="Say it on your microphone"
          >
            Record
          </button>
          <button
            className={source === 'track' ? 'now' : ''}
            aria-pressed={source === 'track'}
            onClick={() => update({ source: 'track' })}
            title="Cut a phrase from a track on a deck"
          >
            From a track
          </button>
        </div>
        {source === 'track' ? (
          <ClipPicker
            onClip={(clip, title) => {
              clipName.current = title
              spoken.current = ''
              heardChange.current = !!clip && listen
              setRaw(clip)
              if (!clip) setDrop(null)
            }}
          />
        ) : source === 'mac' ? (
          <>
            <input
              className="dr-text"
              value={text}
              maxLength={160}
              aria-label="Drop text"
              placeholder="Type the drop: your sound's name, a shout-out…"
              onChange={(e) => update({ text: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && void make()}
            />
            <div className="dr-chips" aria-label="Ideas">
              {SUGGESTIONS.map((s) => (
                <button key={s} onClick={() => update({ text: s })} className={text === s ? 'now' : ''}>
                  {s}
                </button>
              ))}
            </div>
            <div className="dr-voice">
              <select value={voice} aria-label="Voice" onChange={(e) => update({ voice: e.target.value })} disabled={!canSpeak()}>
                {groups.map(([lang, vs]) => (
                  <optgroup key={lang} label={lang}>
                    {vs.map((v) => (
                      <option key={v.name} value={v.name}>
                        {v.name.replace(/\s*\(.*\)$/, '')}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <label title="Speech speed">
                <span>Rhythm</span>
                <input
                  type="range"
                  min={110}
                  max={280}
                  step={5}
                  value={rate}
                  onChange={(e) => update({ rate: Number(e.target.value) })}
                />
              </label>
            </div>
            <button className="dr-make" disabled={!!busy || !text.trim() || !voice} onClick={() => void make()}>
              {busy ?? (ready ? '▶ Play again' : '▶ Make & play')}
            </button>
          </>
        ) : (
          <div className="dr-mic">
            <button
              className={'dr-make dr-rec' + (recording ? ' on' : '')}
              onClick={() => void record()}
              aria-pressed={recording}
            >
              <i aria-hidden="true" />
              {recording ? '■ Stop and use' : '● Record'}
            </button>
            <p className="dr-note">
              Close to the mic and loud; silence at the start and end is trimmed. Only your own voice, or one you may use.
            </p>
          </div>
        )}
        {!canSpeak() && source === 'mac' && <p className="dr-note">Mac voices only exist in the desktop app.</p>}
      </section>

      {/* 2 · SOUND: the style (one click), an effect, and the fine knobs folded away */}
      <section className="dr-col dr-step" aria-label="2. Sound">
        <h4 className="dr-step-title">
          <b>2</b> Sound
        </h4>
        <div className="dr-styles" role="group" aria-label="Style">
          {STYLES.map((s) => (
            <button
              key={s.id}
              className={options.style === s.id ? 'now' : ''}
              aria-pressed={options.style === s.id}
              title={s.hint}
              onClick={() => setOptions({ style: s.id, ...s.set })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="dr-row">
          <span>Effect</span>
          <select value={options.sfx} aria-label="Effect with the drop" onChange={(e) => setOptions({ sfx: e.target.value })}>
            <option value="">None</option>
            {SFX.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={options.sfxAt}
            aria-label="When the effect comes in"
            disabled={!options.sfx}
            onChange={(e) => setOptions({ sfxAt: e.target.value as 'start' | 'end' })}
          >
            <option value="start">at the start</option>
            <option value="end">at the end</option>
          </select>
        </div>
        <details className="dr-fine">
          <summary>Fine tune</summary>
          {/* Every effect on its own knob; double-click puts it back to the style's value. */}
          <div className="dr-knobs">
            <Knob
              label="PITCH"
              value={options.pitch}
              min={-8}
              max={6}
              reset={style.set.pitch}
              format={(v) => (Math.round(v) > 0 ? '+' : '') + Math.round(v) + ' meios-tons'}
              onChange={(v) => setOptions({ pitch: Math.round(v) })}
            />
            <Knob
              label="ECHO"
              value={options.echo}
              min={0}
              max={1}
              reset={style.set.echo}
              format={pct}
              onChange={(v) => setOptions({ echo: v })}
            />
            <Knob
              label="TIME"
              value={options.echoTime}
              min={0.08}
              max={0.75}
              reset={style.set.echoTime}
              format={(v) => Math.round(v * 1000) + ' ms'}
              onChange={(v) => setOptions({ echoTime: v })}
            />
            <Knob
              label="REVERB"
              value={options.reverb}
              min={0}
              max={1}
              reset={style.set.reverb}
              format={pct}
              onChange={(v) => setOptions({ reverb: v })}
            />
            <Knob
              label="DIRTY"
              value={options.drive}
              min={0}
              max={1}
              reset={style.set.drive}
              format={pct}
              onChange={(v) => setOptions({ drive: v })}
            />
            <Knob
              label="BASS"
              value={options.bass}
              min={-1}
              max={1}
              reset={style.set.bass}
              format={(v) => (v > 0 ? '+' : '') + (v * 9).toFixed(1) + ' dB'}
              onChange={(v) => setOptions({ bass: v })}
            />
          </div>
          <label className="dr-listen" title="Turning a knob plays the drop again with the change">
            <input type="checkbox" checked={listen} onChange={(e) => setListen(e.target.checked)} />
            Play again on every change
          </label>
        </details>
        <p className="dr-note">Changing the style or the effect remakes the drop and plays it.</p>
      </section>

      {/* 3 · USE IT: hear it, put it on a pad, keep it */}
      <section className="dr-col dr-step dr-out" aria-label="3. Use it">
        <h4 className="dr-step-title">
          <b>3</b> Use it
        </h4>
        <div className="dr-preview">
          <button
            className="dr-play"
            disabled={!drop}
            onClick={() => (playing ? sampler.stopPreview() : play())}
            aria-label={playing ? 'Stop' : 'Play'}
          >
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              {playing ? <path d="M4 4h8v8H4z" fill="currentColor" /> : <path d="M5 3v10l8-5z" fill="currentColor" />}
            </svg>
          </button>
          <Shape buffer={drop} />
          <span className="dr-len">{drop ? drop.duration.toFixed(1) + 's' : 'no drop yet'}</span>
        </div>
        <div className="dr-place">
          <select value={pad} aria-label="Target pad" onChange={(e) => setPad(Number(e.target.value))}>
            {pads.map((p, i) => (
              <option key={i} value={i}>
                Pad {i + 1}
                {p.name ? ' · ' + p.name : ' · empty'}
              </option>
            ))}
          </select>
          <button
            className="dr-put"
            disabled={!drop}
            onClick={() => void place()}
            title="Replaces the sound on that pad (and keeps the drop in My drops)"
          >
            {placed === pad ? 'On pad ✓' : 'Put on pad'}
          </button>
        </div>
        <form
          className="dr-save"
          onSubmit={(e) => {
            e.preventDefault()
            if (drop) void keep(drop, dropName.trim() || label)
          }}
        >
          <input
            value={dropName}
            maxLength={40}
            placeholder={label}
            aria-label="Name to save the drop under"
            onChange={(e) => setDropName(e.target.value)}
          />
          <button disabled={!drop || kept === drop} title="Keep this drop in the app, under My drops, to use in any later set">
            {drop && kept === drop ? 'Saved ✓' : 'Save'}
          </button>
          <button
            type="button"
            disabled={!drop}
            onClick={() => drop && exportWav(toWav(drop), dropName.trim() || label)}
            title="Export as a WAV file"
          >
            WAV
          </button>
        </form>
      </section>

      {/* My drops: every saved drop, ready for any set */}
      <div className="dr-mine dr-strip" aria-label="My drops">
        <h5>My drops{mine.length ? ' · ' + mine.length : ''}</h5>
        {!mine.length && <p className="dr-note">Saved drops show up here, ready for any set.</p>}
        <ul>
          {mine.map((d) => (
            <li key={d.id}>
              <button
                className="dr-mine-play"
                onClick={() => void hear(d.id)}
                aria-label={(hearing === d.id ? 'Stop ' : 'Play ') + d.name}
              >
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                  {hearing === d.id ? (
                    <path d="M4 4h8v8H4z" fill="currentColor" />
                  ) : (
                    <path d="M5 3v10l8-5z" fill="currentColor" />
                  )}
                </svg>
              </button>
              {renaming === d.id ? (
                <input
                  className="dr-mine-edit"
                  autoFocus
                  defaultValue={d.name}
                  maxLength={40}
                  aria-label={'New name for ' + d.name}
                  onBlur={(e) => {
                    void myDrops.rename(d.id, e.target.value)
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') e.currentTarget.blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                />
              ) : (
                <span
                  className="dr-mine-name"
                  title={'Double-click to rename · saved ' + new Date(d.created).toLocaleString()}
                  onDoubleClick={() => setRenaming(d.id)}
                >
                  {d.name}
                </span>
              )}
              <span className="dr-len">{d.duration.toFixed(1)}s</span>
              <select
                className="dr-mine-pad"
                value=""
                aria-label={'Put ' + d.name + ' on a pad'}
                onChange={(e) => e.target.value !== '' && void toPad(d, Number(e.target.value))}
              >
                <option value="">{placedOn[d.id] !== undefined ? 'On pad ' + (placedOn[d.id] + 1) + ' ✓' : 'To pad…'}</option>
                {pads.map((p, i) => (
                  <option key={i} value={i}>
                    Pad {i + 1}
                    {p.name ? ' · ' + p.name : ' · empty'}
                  </option>
                ))}
              </select>
              <button className="row-btn show" onClick={() => setRenaming(d.id)} title="Rename" aria-label={'Rename ' + d.name}>
                ✎
              </button>
              <button
                className="row-btn show"
                onClick={() => void myDrops.wav(d.id).then((w) => w && exportWav(w.slice(), d.name))}
                title="Export as a WAV file"
                aria-label={'Export ' + d.name}
              >
                ⤓
              </button>
              <button
                className="row-btn show x"
                onClick={() => void myDrops.remove(d.id)}
                title="Delete"
                aria-label={'Delete ' + d.name}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
