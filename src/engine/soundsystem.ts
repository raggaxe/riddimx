import { mixer } from './mixer'

/**
 * Sound-system effects for the sampler: real recordings shipped with the app (public/sfx),
 * plus a dub siren made from scratch.
 */
export interface Sfx {
  id: string
  label: string
}

export const SFX: Sfx[] = [
  { id: 'airhorn', label: 'Air horn' },
  { id: 'pull-up', label: 'Pull up!' },
  { id: 'laser-dub', label: 'Laser dub' },
  { id: 'foghorn', label: 'Fog horn' },
  { id: 'fire', label: 'Fire!' },
  { id: 'jah', label: 'Jah!' },
  { id: 'greetings', label: 'Greetings' },
  { id: 'bo', label: 'Bo!' },
  { id: 'blaze', label: 'Blaze' },
  { id: 'whaa', label: 'Whaa' },
  { id: 'ay-ay', label: 'Ay ay' },
  { id: 'bulletproof', label: 'Bulletproof' },
  { id: 'rrrr', label: 'Rrrrr' },
  { id: 'uh', label: 'Uh' },
  { id: 'one-more', label: 'One more' },
  { id: 'ela-toma', label: 'Ela toma' },
  { id: 'shatta-102', label: 'Shatta 102' },
  { id: 'siren', label: 'Dub siren' },
]

/** What each of the eight pads holds until the user puts something else there. */
export const DEFAULT_PADS = ['airhorn', 'pull-up', 'laser-dub', 'siren', 'fire', 'jah', 'greetings', 'bo']

export const sfxLabel = (id: string): string => SFX.find((x) => x.id === id)?.label ?? id

const SR = 44100

function offline(seconds: number): OfflineAudioContext {
  return new OfflineAudioContext(2, Math.ceil(SR * seconds), SR)
}

/** Dub siren: a square wave wobbling up and down, fading into its own echoes. */
function siren(): Promise<AudioBuffer> {
  const ctx = offline(3)
  const osc = ctx.createOscillator()
  osc.type = 'square'
  osc.frequency.value = 900
  const wobble = ctx.createOscillator()
  wobble.frequency.setValueAtTime(7, 0)
  wobble.frequency.linearRampToValueAtTime(3, 1.6)
  const depth = ctx.createGain()
  depth.gain.value = 320
  wobble.connect(depth)
  depth.connect(osc.frequency)
  const level = ctx.createGain()
  level.gain.setValueAtTime(0.16, 0)
  level.gain.setValueAtTime(0.16, 1.2)
  level.gain.linearRampToValueAtTime(0, 1.7)
  const tone = ctx.createBiquadFilter()
  tone.type = 'lowpass'
  tone.frequency.value = 3200
  const echo = ctx.createDelay(1)
  echo.delayTime.value = 0.33
  const feedback = ctx.createGain()
  feedback.gain.value = 0.5
  osc.connect(level)
  level.connect(tone)
  tone.connect(ctx.destination)
  tone.connect(echo)
  echo.connect(feedback)
  feedback.connect(echo)
  echo.connect(ctx.destination)
  osc.start()
  wobble.start()
  return ctx.startRendering()
}

const made = new Map<string, Promise<AudioBuffer>>()

/** The effect as audio, loaded (or rendered) once and then reused. */
export function sfx(id: string): Promise<AudioBuffer> {
  let buffer = made.get(id)
  if (!buffer) {
    buffer =
      id === 'siren'
        ? siren()
        : fetch('/sfx/' + id + '.m4a')
            .then((res) => {
              if (!res.ok) throw new Error('missing sound ' + id)
              return res.arrayBuffer()
            })
            .then((data) => mixer.ctx.decodeAudioData(data))
    buffer.catch(() => made.delete(id)) // allow another try
    made.set(id, buffer)
  }
  return buffer
}
