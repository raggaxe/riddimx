import { Store, clamp } from '../store'
import { mixer } from './mixer'

/**
 * The MC's microphone, as a channel of the master:
 *   mic ─► low cut ─► compressor ─► level ─► TALK (open / closed) ─┬─► master (after the duck)
 *                                                                  ├─► tape echo send
 *                                                                  └─► spring send
 * While the mic is open and someone speaks, the music dips (ducking) so the voice cuts through.
 * The music bus passes through `duck`; the voice joins at `join`, after it, so it never ducks itself.
 */

export interface MicState {
  on: boolean // microphone in use (permission given, device open)
  talk: boolean // TALK pressed: the voice goes to the dance
  level: number // 0..1.5
  echo: number // 0..1 send to the tape echo
  spring: number // 0..1 send to the spring
  duck: number // 0..1 how much the music dips while talking (0 = never)
  error: string | null
  speaking: boolean // voice detected now
}

const LS = 'vx_mic'

class Mic extends Store<MicState> {
  /** The music goes through here (ducked while the MC speaks). */
  readonly duck: GainNode
  /** Music after the duck plus the voice: what the compressor and limiter get. */
  readonly join: GainNode
  readonly echoSend: GainNode
  readonly springSend: GainNode
  private gate: GainNode
  private levelNode: GainNode
  private chain: AudioNode
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode
  private timer = 0

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
      echo: clamp(saved.echo ?? 0.25, 0, 1),
      spring: clamp(saved.spring ?? 0.15, 0, 1),
      duck: clamp(saved.duck ?? 0.5, 0, 1),
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
    this.levelNode = ctx.createGain()
    this.gate = ctx.createGain()
    this.gate.gain.value = 0
    this.echoSend = ctx.createGain()
    this.springSend = ctx.createGain()
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 1024
    lowCut.connect(presence).connect(comp).connect(this.levelNode).connect(this.gate)
    this.gate.connect(this.join)
    this.gate.connect(this.echoSend)
    this.gate.connect(this.springSend)
    comp.connect(this.analyser)
    this.chain = lowCut
    this.apply()
    // The voice follows the master fader too (it joins after it).
    mixer.subscribe(() => this.apply())
  }

  private persist(): void {
    const { level, echo, spring, duck } = this.state
    try {
      localStorage.setItem(LS, JSON.stringify({ level, echo, spring, duck }))
    } catch {
      /* not remembered */
    }
  }

  private apply(): void {
    const s = this.state
    const now = mixer.ctx.currentTime
    this.levelNode.gain.setTargetAtTime(s.level * mixer.get().master * 1.25, now, 0.02)
    this.gate.gain.setTargetAtTime(s.on && s.talk ? 1 : 0, now, 0.012)
    this.echoSend.gain.setTargetAtTime(s.echo, now, 0.02)
    this.springSend.gain.setTargetAtTime(s.spring * 1.2, now, 0.02)
  }

  update(change: Partial<Pick<MicState, 'level' | 'echo' | 'spring' | 'duck'>>): void {
    this.set(change)
    this.apply()
    this.persist()
  }

  /** Opens the microphone (asks for permission the first time). */
  async open(): Promise<void> {
    if (this.state.on) return
    try {
      mixer.resume()
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      })
      this.source = mixer.ctx.createMediaStreamSource(this.stream)
      this.source.connect(this.chain)
      this.set({ on: true, error: null })
      this.apply()
      this.timer = window.setInterval(() => this.watch(), 40)
    } catch {
      this.set({ error: 'Sem acesso ao microfone. Autoriza-o nas Definições do Mac, em Privacidade.' })
    }
  }

  close(): void {
    window.clearInterval(this.timer)
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    this.source = null
    this.stream = null
    this.set({ on: false, talk: false, speaking: false })
    this.apply()
    this.duck.gain.setTargetAtTime(1, mixer.ctx.currentTime, 0.1)
  }

  setTalk(talk: boolean): void {
    if (talk && !this.state.on) void this.open()
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
