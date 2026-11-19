import { Store, clamp } from '../store'
import { mixer } from './mixer'
import { desktop } from './ytremote'

/**
 * The MC's microphone, as a channel of the master:
 *   mic ─► low cut ─► compressor ─► COLOUR (filter, drive) ─► level ─► TALK (open / closed) ─┬─► master (after the duck)
 *                                                                                            ├─► voice tape echo ─┐
 *                                                                                            └─► voice spring ────┴─► FX ─► master
 * While the mic is open and someone speaks, the music dips (ducking) so the voice cuts through.
 * The music bus passes through `duck`; the voice and its effects join at `join`, after it, so they
 * never dip with the music. The voice has its own echo (time, repeats, tone) and spring, so an MC
 * can be dubbed without touching the rack's echo.
 */

/** Echo time of the voice: the Eco fita's own, or a division of the beat of its own. */
export const VOICE_TIMES = ['rack', '1/8', '1/4', '3/8', '1/2', '3/4'] as const
export type VoiceTime = (typeof VOICE_TIMES)[number]
const BEATS: Record<Exclude<VoiceTime, 'rack'>, number> = { '1/8': 0.5, '1/4': 1, '3/8': 1.5, '1/2': 2, '3/4': 3 }

export interface MicState {
  on: boolean // microphone in use (permission given, device open)
  talk: boolean // TALK pressed: the voice goes to the dance
  level: number // 0..1.5
  echo: number // 0..1 send to the voice's tape echo
  spring: number // 0..1 send to the voice's spring
  duck: number // 0..1 how much the music dips while talking (0 = never)
  // colour
  filter: number // -1..1: below 0 darker (low pass), above 0 thinner (high pass, radio), 0 = open
  drive: number // 0..1 saturation, up to a megaphone
  // the voice's echo
  time: VoiceTime
  repeats: number // 0..0.95
  tone: number // 0..1 dark to bright
  fx: number // 0..1.5 level of the echo and spring of the voice
  throwing: boolean // THROW: the voice sent full into its echo, while held
  error: string | null
  speaking: boolean // voice detected now
}

type Settings = Pick<MicState, 'level' | 'echo' | 'spring' | 'duck' | 'filter' | 'drive' | 'time' | 'repeats' | 'tone' | 'fx'>

/** Ready-made voices: one press sets the colour and the effects. */
export const VOICE_PRESETS: { id: string; label: string; set: Partial<Settings> }[] = [
  { id: 'clean', label: 'CLEAN', set: { filter: 0, drive: 0, echo: 0.15, spring: 0.1, repeats: 0.3, tone: 0.55, time: 'rack' } },
  { id: 'dub', label: 'DUB MC', set: { filter: 0.12, drive: 0.15, echo: 0.55, spring: 0.3, repeats: 0.6, tone: 0.4, time: '3/8' } },
  { id: 'radio', label: 'RADIO', set: { filter: 0.62, drive: 0.35, echo: 0.35, spring: 0.15, repeats: 0.45, tone: 0.6, time: '1/4' } },
  { id: 'mega', label: 'MEGAPHONE', set: { filter: 0.45, drive: 0.85, echo: 0.4, spring: 0.25, repeats: 0.5, tone: 0.5, time: '1/2' } },
]

const LS = 'vx_mic'
const SETTINGS: (keyof Settings)[] = ['level', 'echo', 'spring', 'duck', 'filter', 'drive', 'time', 'repeats', 'tone', 'fx']

function driveCurve(drive: number): Float32Array<ArrayBuffer> {
  const n = 1024
  const c = new Float32Array(n)
  const k = 1 + drive * 24
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1
    c[i] = Math.tanh(k * x) / Math.tanh(k)
  }
  return c
}

function tapeCurve(k: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(1024)
  for (let i = 0; i < c.length; i++) c[i] = Math.tanh(k * ((i / (c.length - 1)) * 2 - 1)) / k
  return c
}

class Mic extends Store<MicState> {
  /** The music goes through here (ducked while the MC speaks). */
  readonly duck: GainNode
  /** Music after the duck plus the voice: what the compressor and limiter get. */
  readonly join: GainNode
  private echoSend: GainNode
  private springSend: GainNode
  private gate: GainNode
  private levelNode: GainNode
  private colour: BiquadFilterNode
  private shaper: WaveShaperNode
  private makeup: GainNode
  private delay: DelayNode
  private toneFilter: BiquadFilterNode
  private feedback: GainNode
  private springNode: ConvolverNode
  private fxOut: GainNode
  private fxColour: BiquadFilterNode
  private tape: WaveShaperNode
  private chain: AudioNode
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode
  private timer = 0
  private beat = 0.5 // seconds per beat of the music playing (set by the rack)
  private rackTime = 0.375 // the Eco fita's own time
  private talkBeforeThrow = false

  constructor() {
    let saved: Partial<MicState> = {}
    try {
      saved = JSON.parse(localStorage.getItem(LS) || '{}')
    } catch {
      /* defaults */
    }
    super({
      on: false,
      talk: false,
      level: clamp(saved.level ?? 1, 0, 1.5),
      echo: clamp(saved.echo ?? 0.4, 0, 1),
      spring: clamp(saved.spring ?? 0.25, 0, 1),
      duck: clamp(saved.duck ?? 0.5, 0, 1),
      filter: clamp(saved.filter ?? 0, -1, 1),
      drive: clamp(saved.drive ?? 0, 0, 1),
      time: VOICE_TIMES.includes(saved.time as VoiceTime) ? (saved.time as VoiceTime) : 'rack',
      repeats: clamp(saved.repeats ?? 0.5, 0, 0.95),
      tone: clamp(saved.tone ?? 0.5, 0, 1),
      fx: clamp(saved.fx ?? 1, 0, 1.5),
      throwing: false,
      error: null,
      speaking: false,
    })
    const ctx = mixer.ctx
    this.duck = ctx.createGain()
    this.join = ctx.createGain()
    this.duck.connect(this.join)
    const lowCut = ctx.createBiquadFilter()
    lowCut.type = 'highpass'
    lowCut.frequency.value = 100
    const presence = ctx.createBiquadFilter()
    presence.type = 'peaking'
    presence.frequency.value = 3000
    presence.gain.value = 3
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -26
    comp.ratio.value = 4
    comp.attack.value = 0.004
    comp.release.value = 0.15
    // Colour: one filter that darkens one way and thins the other, then the drive.
    this.colour = ctx.createBiquadFilter()
    this.colour.Q.value = 0.9
    this.shaper = ctx.createWaveShaper()
    this.shaper.oversample = '2x'
    this.makeup = ctx.createGain()
    this.levelNode = ctx.createGain()
    this.gate = ctx.createGain()
    this.gate.gain.value = 0
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    lowCut.connect(presence).connect(comp).connect(this.colour).connect(this.shaper).connect(this.makeup)
    this.makeup.connect(this.levelNode).connect(this.gate)
    this.gate.connect(this.join)
    comp.connect(this.analyser)
    this.chain = lowCut

    // The voice's tape echo: send ─► tape ─► delay ⟲ (tone, low cut, repeats)
    // Everything after the send lives in the loop or on the return, so turning those knobs changes
    // repeats already ringing: REPETIR, TOM, TEMPO in the loop, DRIVE on the tape, FILTRO on the return.
    this.fxOut = ctx.createGain()
    this.fxColour = ctx.createBiquadFilter()
    this.fxColour.Q.value = 0.9
    this.fxColour.connect(this.fxOut).connect(this.join)
    this.echoSend = ctx.createGain()
    const tape = (this.tape = ctx.createWaveShaper())
    this.delay = ctx.createDelay(4)
    this.toneFilter = ctx.createBiquadFilter()
    this.toneFilter.type = 'lowpass'
    const echoLowCut = ctx.createBiquadFilter()
    echoLowCut.type = 'highpass'
    echoLowCut.frequency.value = 250
    this.feedback = ctx.createGain()
    this.gate.connect(this.echoSend).connect(tape).connect(this.delay)
    this.delay.connect(this.toneFilter).connect(echoLowCut).connect(this.feedback).connect(tape)
    echoLowCut.connect(this.fxColour)
    // A little tape wobble on the repeats.
    const wow = ctx.createOscillator()
    wow.frequency.value = 0.5
    const wowDepth = ctx.createGain()
    wowDepth.gain.value = 0.0007
    wow.connect(wowDepth).connect(this.delay.delayTime)
    wow.start()

    // The voice's spring (the tank's sound comes from the rack: useSpring).
    this.springSend = ctx.createGain()
    const springTone = ctx.createBiquadFilter()
    springTone.type = 'highpass'
    springTone.frequency.value = 300
    this.springNode = ctx.createConvolver()
    this.gate.connect(this.springSend).connect(springTone).connect(this.springNode).connect(this.fxColour)

    this.apply()
    // The voice follows the master fader too (it joins after it).
    mixer.subscribe(() => this.apply())
  }

  /** The spring tank's sound, shared with the rack's spring. */
  useSpring(buffer: AudioBuffer): void {
    if (!this.springNode.buffer) this.springNode.buffer = buffer
  }

  /** The tempo of the music playing and the Eco fita's own time, from the rack (follows them). */
  setTempo(beat: number, rackTime: number): void {
    this.beat = beat
    this.rackTime = rackTime
    this.delay.delayTime.setTargetAtTime(this.echoTime, mixer.ctx.currentTime, 0.15)
  }

  /** Delay time of the voice's echo, in seconds. */
  get echoTime(): number {
    const t = this.state.time
    return Math.min(3.5, t === 'rack' ? this.rackTime : this.beat * BEATS[t])
  }

  private persist(): void {
    const out: Partial<MicState> = {}
    for (const k of SETTINGS) (out as Record<string, unknown>)[k] = this.state[k]
    try {
      localStorage.setItem(LS, JSON.stringify(out))
    } catch {
      /* not remembered */
    }
  }

  private lastDrive = -1

  private apply(): void {
    const s = this.state
    const now = mixer.ctx.currentTime
    const to = (p: AudioParam, v: number, tc = 0.02) => p.setTargetAtTime(v, now, tc)
    to(this.levelNode.gain, s.level * mixer.get().master * 1.25)
    to(this.gate.gain, s.on && s.talk ? 1 : 0, 0.012)
    to(this.echoSend.gain, s.throwing ? 1 : s.echo * 0.9, s.throwing ? 0.005 : 0.03)
    to(this.springSend.gain, s.spring * 1.6)
    to(this.fxOut.gain, s.fx)
    // Colour: below 0 a low pass closing to 300 Hz, above 0 a high pass opening to 2.5 kHz (thin radio).
    // The same filter sits on the effects' return, so sweeping it moves the tail that is ringing too.
    const f = s.filter
    for (const node of [this.colour, this.fxColour]) {
      if (Math.abs(f) < 0.02) {
        node.type = 'allpass'
      } else if (f < 0) {
        node.type = 'lowpass'
        to(node.frequency, 18000 * Math.pow(300 / 18000, -f))
      } else {
        node.type = 'highpass'
        to(node.frequency, 40 * Math.pow(2500 / 40, f))
      }
    }
    if (s.drive !== this.lastDrive) {
      this.lastDrive = s.drive
      this.shaper.curve = driveCurve(s.drive)
      // The tape in the loop saturates harder with the drive: the repeats get dirtier as they go round.
      this.tape.curve = tapeCurve(1.6 + s.drive * 2)
    }
    to(this.makeup.gain, 1 / (1 + s.drive * 1.2))
    to(this.feedback.gain, s.repeats)
    to(this.toneFilter.frequency, 1200 * Math.pow(7000 / 1200, s.tone))
    to(this.delay.delayTime, this.echoTime, 0.15)
  }

  update(change: Partial<Settings>): void {
    this.set(change)
    this.apply()
    this.persist()
  }

  /** One of the ready-made voices. */
  usePreset(id: string): void {
    const p = VOICE_PRESETS.find((x) => x.id === id)
    if (p) this.update(p.set)
  }

  /** Which ready-made voice the settings match now, if any. */
  get preset(): string | null {
    const s = this.state
    const p = VOICE_PRESETS.find((x) =>
      Object.entries(x.set).every(([k, v]) =>
        typeof v === 'number' ? Math.abs((s[k as keyof Settings] as number) - v) < 0.01 : s[k as keyof Settings] === v,
      ),
    )
    return p?.id ?? null
  }

  /** THROW: held, the voice opens and goes full into its echo; let go, the repeats carry on. */
  throwVoice(on: boolean): void {
    if (on === this.state.throwing) return
    if (on) {
      this.talkBeforeThrow = this.state.talk
      this.set({ throwing: true })
      this.setTalk(true)
    } else {
      this.set({ throwing: false })
      if (!this.talkBeforeThrow) this.setTalk(false)
    }
    this.apply()
  }

  /** Opens the microphone (asks for permission the first time). */
  async open(): Promise<boolean> {
    if (this.state.on) return true
    try {
      mixer.resume()
      // On the Mac the system has to say yes first (it asks the user once).
      const access = (await desktop?.micAccess?.()) ?? 'granted'
      if (access === 'denied' || access === 'restricted') {
        this.set({ error: 'The Mac won\'t let RiddimX hear the microphone. Click to open Privacy › Microphone and allow it.' })
        return false
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false, ...mixer.inputConstraint() },
      })
      // The device went away (unplugged, Bluetooth dropped): close cleanly so FALAR shows it.
      this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        this.close()
        this.set({ error: 'The microphone disconnected. Plug it in again and press TALK.' })
      })
      this.source = mixer.ctx.createMediaStreamSource(this.stream)
      this.source.connect(this.chain)
      this.set({ on: true, error: null })
      this.apply()
      this.timer = window.setInterval(() => this.watch(), 40)
      return true
    } catch (e) {
      const name = (e as DOMException)?.name
      this.set({
        error:
          name === 'NotFoundError'
            ? 'No microphone found. Plug one in and press TALK again.'
            : 'No access to the microphone. Click to open Privacy › Microphone and allow it.',
      })
      return false
    }
  }

  /** The system's microphone privacy settings (after a "no"). */
  openSettings(): void {
    void desktop?.micSettings?.()
  }

  /** The input changed in the Áudio tab: open it again on the new one, still on air if it was. */
  async reopen(): Promise<void> {
    if (!this.state.on) return
    const talk = this.state.talk
    this.close()
    if (await this.open()) this.setTalk(talk)
  }

  close(): void {
    window.clearInterval(this.timer)
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.source = null
    this.stream = null
    this.set({ on: false, talk: false, speaking: false, throwing: false })
    this.apply()
    this.duck.gain.setTargetAtTime(1, mixer.ctx.currentTime, 0.1)
  }

  setTalk(talk: boolean): void {
    if (talk && !this.state.on) {
      // Only on air once the microphone really opened.
      void this.open().then((ok) => {
        if (ok) this.setTalk(true)
      })
      return
    }
    this.set({ talk })
    this.apply()
    if (!talk) this.duck.gain.setTargetAtTime(1, mixer.ctx.currentTime, 0.25)
  }

  /** Voice detection for the ducking: quick to dip, slow to come back (no pumping between words). */
  private watch(): void {
    const buf = new Float32Array(this.analyser.fftSize)
    this.analyser.getFloatTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += v * v
    const db = 10 * Math.log10(sum / buf.length + 1e-12)
    const speaking = this.state.talk && db > -42
    if (speaking !== this.state.speaking) this.set({ speaking })
    const now = mixer.ctx.currentTime
    const target = speaking ? 1 - this.state.duck * 0.75 : 1 // up to -12 dB
    this.duck.gain.setTargetAtTime(target, now, speaking ? 0.04 : 0.45)
  }
}

export const mic = new Mic()
