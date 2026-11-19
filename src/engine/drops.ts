import { mixer } from './mixer'
import { sfx } from './soundsystem'
import { desktop } from './ytremote'

/**
 * Drops: short spoken jingles for the sampler pads ("RiddimX sound!", "Pull up selecta!").
 * The voice is either one of the Mac's own voices (nothing to download) or the DJ's own voice
 * recorded from the microphone. A style then makes it sound like a sound-system drop.
 */

export interface Voice {
  name: string
  lang: string
}

export type DropStyle = 'limpo' | 'mc' | 'megafone' | 'gigante' | 'dub' | 'radio'

/** Each style is a starting point for every knob; the knobs then take it anywhere. */
export const STYLES: { id: DropStyle; label: string; hint: string; set: Omit<DropOptions, 'style' | 'sfx' | 'sfxAt'> }[] = [
  {
    id: 'mc',
    label: 'MC',
    hint: 'MC voice: upfront, a bit dirty, with a short echo',
    set: { pitch: 0, echo: 0.3, echoTime: 0.14, reverb: 0.1, drive: 0.25, bass: 0.2 },
  },
  {
    id: 'dub',
    label: 'Dub',
    hint: 'Long echo and reverb: the phrase repeats and fades',
    set: { pitch: 0, echo: 0.7, echoTime: 0.375, reverb: 0.45, drive: 0.2, bass: 0.2 },
  },
  {
    id: 'gigante',
    label: 'Giant',
    hint: 'Deep, huge voice',
    set: { pitch: -5, echo: 0.35, echoTime: 0.3, reverb: 0.35, drive: 0.15, bass: 0.7 },
  },
  {
    id: 'megafone',
    label: 'Megaphone',
    hint: 'Mids only, distorted',
    set: { pitch: 0, echo: 0.2, echoTime: 0.12, reverb: 0, drive: 0.9, bass: -0.6 },
  },
  {
    id: 'radio',
    label: 'Radio',
    hint: 'Thin and squeezed, like a pirate radio',
    set: { pitch: 0, echo: 0.15, echoTime: 0.1, reverb: 0.05, drive: 0.35, bass: -0.4 },
  },
  {
    id: 'limpo',
    label: 'Clean',
    hint: 'The voice as it is, just tidied',
    set: { pitch: 0, echo: 0, echoTime: 0.2, reverb: 0, drive: 0, bass: 0 },
  },
]

export interface DropOptions {
  style: DropStyle
  pitch: number // semitones, -8..6
  echo: number // 0..1, how much echo (and how long it keeps repeating)
  echoTime: number // seconds between repeats, 0.08..0.75
  reverb: number // 0..1, room / spring around the voice
  drive: number // 0..1, dirt: clean to distorted
  bass: number // -1..1, thin to heavy
  sfx: string // sound-system effect played with it, '' = none
  sfxAt: 'start' | 'end'
}

export const SUGGESTIONS = [
  'RiddimX sound!',
  'Pull up selecta!',
  'Fire pon di dance!',
  'Hold the tune!',
  'Big up the massive!',
  'Jah Rastafari!',
]

export const canSpeak = (): boolean => !!desktop?.speak

export async function voices(): Promise<Voice[]> {
  try {
    return (await desktop?.voices?.()) ?? []
  } catch {
    return []
  }
}

/** The text in one of the Mac's voices; words per minute 90..360. */
export async function speak(text: string, voice: string, rate: number): Promise<AudioBuffer> {
  const wav = await desktop?.speak?.(text, voice, rate)
  if (!wav) throw new Error('Couldn\'t make the voice.')
  return trim(await mixer.ctx.decodeAudioData(new Uint8Array(wav).buffer))
}

/** Microphone recording: start() then stop() gives the take, with the silence at both ends removed. */
export class MicTake {
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private parts: Blob[] = []

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true, ...mixer.inputConstraint() },
    })
    this.parts = []
    this.recorder = new MediaRecorder(this.stream)
    this.recorder.ondataavailable = (e) => e.data.size && this.parts.push(e.data)
    this.recorder.start()
  }

  stop(): Promise<AudioBuffer> {
    const recorder = this.recorder
    if (!recorder) return Promise.reject(new Error('Nothing to record.'))
    return new Promise((resolve, reject) => {
      recorder.onstop = async () => {
        this.stream?.getTracks().forEach((t) => t.stop())
        this.recorder = null
        this.stream = null
        try {
          const data = await new Blob(this.parts).arrayBuffer()
          resolve(trim(await mixer.ctx.decodeAudioData(data)))
        } catch {
          reject(new Error('The recording couldn\'t be read.'))
        }
      }
      recorder.stop()
    })
  }

  cancel(): void {
    this.recorder?.stop()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.recorder = null
    this.stream = null
  }
}

/** Cut the silence before and after the voice (keeps a few milliseconds so nothing clicks). */
function trim(buffer: AudioBuffer): AudioBuffer {
  const data = buffer.getChannelData(0)
  const gate = 0.02
  let a = 0
  let b = data.length - 1
  while (a < b && Math.abs(data[a]) < gate) a++
  while (b > a && Math.abs(data[b]) < gate) b--
  const pad = Math.floor(buffer.sampleRate * 0.03)
  a = Math.max(0, a - pad)
  b = Math.min(data.length, b + pad * 4)
  if (b - a < buffer.sampleRate * 0.1) return buffer
  const out = new AudioBuffer({ length: b - a, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(a, b), c)
  return out
}

/** Gentle-to-hard saturation curve. */
function drive(amount: number): Float32Array<ArrayBuffer> {
  const n = 2048
  const curve = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    curve[i] = Math.tanh(amount * x) / Math.tanh(amount)
  }
  return curve
}

/** A short decaying noise burst as a reverb impulse (stereo, a little different on each side). */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds)
  const ir = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    for (let i = 0; i < length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3)
  }
  return ir
}

/**
 * The finished drop: voice through the style, its echo tail, and the optional sound-system effect,
 * rendered offline and normalised just under full scale.
 */
export async function render(voice: AudioBuffer, o: DropOptions): Promise<AudioBuffer> {
  const rate = 44100
  const speed = Math.pow(2, o.pitch / 12) // the classic way: slower is lower
  const voiceLength = voice.duration / speed
  const fx = o.sfx ? await sfx(o.sfx).catch(() => null) : null
  // Room for the repeats to die away: more echo and longer gaps ring longer; the reverb adds its own tail.
  const echoTail = Math.max(o.echo > 0.01 ? o.echoTime * (2 + o.echo * 10) : 0.15, o.reverb > 0.01 ? 1 + o.reverb * 2 : 0)
  const start = fx && o.sfxAt === 'start' ? Math.max(0, fx.duration * 0.55) : 0
  const length = Math.max(start + voiceLength + echoTail, fx ? (o.sfxAt === 'start' ? fx.duration : voiceLength * 0.85 + fx.duration) : 0)
  const ctx = new OfflineAudioContext(2, Math.ceil((length + 0.1) * rate), rate)

  const src = ctx.createBufferSource()
  src.buffer = voice
  src.playbackRate.value = speed

  const chain: AudioNode[] = []
  const filter = (type: BiquadFilterType, freq: number, gain = 0, q = 0.7) => {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = freq
    f.gain.value = gain
    f.Q.value = q
    chain.push(f)
  }
  const shape = (amount: number) => {
    const w = ctx.createWaveShaper()
    w.curve = drive(amount)
    w.oversample = '4x'
    chain.push(w)
  }
  const squash = (threshold: number, ratio: number) => {
    const c = ctx.createDynamicsCompressor()
    c.threshold.value = threshold
    c.ratio.value = ratio
    c.attack.value = 0.003
    c.release.value = 0.12
    chain.push(c)
  }

  switch (o.style) {
    case 'limpo':
      filter('highpass', 80)
      filter('peaking', 3000, 3, 1)
      squash(-20, 3)
      break
    case 'mc':
    case 'dub':
      filter('highpass', 110)
      filter('lowshelf', 220, 2)
      filter('peaking', 2600, 6, 1)
      squash(-24, 5)
      break
    case 'gigante':
      filter('highpass', 50)
      filter('lowshelf', 140, 6)
      filter('peaking', 2200, 3, 1)
      squash(-22, 4)
      break
    case 'megafone':
      filter('highpass', 600, 0, 1)
      filter('lowpass', 3400, 0, 1)
      filter('peaking', 1500, 9, 1.2)
      squash(-18, 6)
      break
    case 'radio':
      filter('highpass', 320)
      filter('lowpass', 4200)
      filter('peaking', 2000, 5, 1)
      squash(-30, 10)
      break
  }

  // The knobs, on top of the style's colour: weight (bass) and dirt (drive).
  filter('lowshelf', 150, o.bass * 9)
  if (o.drive > 0.02) shape(1 + o.drive * 10)

  let node: AudioNode = src
  for (const n of chain) {
    node.connect(n)
    node = n
  }
  const out = ctx.createGain()
  node.connect(out)

  // Echo: a delay feeding itself through a darkening filter, like a tape echo.
  if (o.echo > 0.01) {
    const send = ctx.createGain()
    send.gain.value = 0.15 + o.echo * 0.5
    const delay = ctx.createDelay(2)
    delay.delayTime.value = o.echoTime
    const feedback = ctx.createGain()
    feedback.gain.value = Math.min(0.72, 0.1 + o.echo * 0.62)
    const dark = ctx.createBiquadFilter()
    dark.type = 'lowpass'
    dark.frequency.value = 3600 - o.echo * 1600
    node.connect(send)
    send.connect(delay)
    delay.connect(dark)
    dark.connect(feedback)
    feedback.connect(delay)
    dark.connect(out)
  }
  // Reverb: room and spring around the voice (and around the echoes).
  if (o.reverb > 0.01) {
    const verb = ctx.createConvolver()
    verb.buffer = impulse(ctx, 1.2 + o.reverb * 2)
    const wet = ctx.createGain()
    wet.gain.value = o.reverb * 0.7
    out.connect(wet)
    wet.connect(verb)
    verb.connect(ctx.destination)
  }
  out.connect(ctx.destination)
  src.start(start)

  if (fx) {
    const f = ctx.createBufferSource()
    f.buffer = fx
    const level = ctx.createGain()
    level.gain.value = 0.8
    f.connect(level).connect(ctx.destination)
    f.start(o.sfxAt === 'start' ? 0 : start + voiceLength * 0.85)
  }

  const done = await ctx.startRendering()
  // Loud but never clipping: peak at -1 dB.
  let peak = 0
  for (let c = 0; c < done.numberOfChannels; c++) {
    const d = done.getChannelData(c)
    for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]))
  }
  const gain = peak > 0 ? 0.89 / peak : 1
  // Where the sound really ends (below -60 dB), so the pad is no longer than what is heard.
  let end = 0
  for (let c = 0; c < done.numberOfChannels; c++) {
    const d = done.getChannelData(c)
    for (let i = 0; i < d.length; i++) {
      d[i] *= gain
      if (Math.abs(d[i]) > 0.001 && i > end) end = i
    }
  }
  const frames = Math.min(done.length, end + Math.floor(rate * 0.05))
  if (frames >= done.length) return done
  const cut = new AudioBuffer({ length: frames, numberOfChannels: done.numberOfChannels, sampleRate: rate })
  for (let c = 0; c < done.numberOfChannels; c++) {
    const d = done.getChannelData(c).slice(0, frames)
    const fade = Math.min(frames, Math.floor(rate * 0.04)) // no click at the cut
    for (let i = 0; i < fade; i++) d[frames - 1 - i] *= i / fade
    cut.copyToChannel(d, c)
  }
  return cut
}

/** 16-bit stereo WAV, for the sampler pad and for saving. */
export function toWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytes = new Uint8Array(44 + frames * channels * 2)
  const view = new DataView(bytes.buffer)
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)))
  text(0, 'RIFF')
  view.setUint32(4, 36 + frames * channels * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, frames * channels * 2, true)
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let at = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c][i]))
      view.setInt16(at, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      at += 2
    }
  }
  return bytes
}
