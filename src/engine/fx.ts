/**
 * One effect slot per deck, placed after the EQ / filter and before the channel fader.
 * All four effects are wired in parallel with the dry signal; only the selected one gets any level.
 */
import { dubSettings, type DubSettings } from './dub'

export const FX = ['echo', 'reverb', 'flanger', 'wah'] as const
export type FxType = (typeof FX)[number]

/** Decaying noise: a simple, dense room tail. */
function impulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds)
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3)
  }
  return buffer
}

export class FxUnit {
  readonly input: GainNode
  readonly output: GainNode
  private dry: GainNode
  private wet: Record<FxType, GainNode>
  private echoDelay: DelayNode
  private dryKill: GainNode
  private dubSend: GainNode
  private dubThin: BiquadFilterNode
  private dubDelay: DelayNode
  private dubFeedback: GainNode
  private dubDark: BiquadFilterNode
  private dubReturn: GainNode
  private dubSpring: GainNode
  private dubWobble: GainNode
  private dubHeld = false

  constructor(private ctx: BaseAudioContext) {
    const gain = (value: number): GainNode => {
      const node = ctx.createGain()
      node.gain.value = value
      return node
    }
    const lfo = (hz: number, depth: number, target: AudioParam): void => {
      const osc = ctx.createOscillator()
      osc.frequency.value = hz
      const amount = gain(depth)
      osc.connect(amount)
      amount.connect(target)
      osc.start()
    }
    this.input = gain(1)
    this.output = gain(1)
    this.dry = gain(1)
    this.dryKill = gain(1) // the dub throw can drop the dry music out while held
    this.input.connect(this.dry)
    this.dry.connect(this.dryKill)
    this.dryKill.connect(this.output)
    this.wet = { echo: gain(0), reverb: gain(0), flanger: gain(0), wah: gain(0) }
    for (const node of Object.values(this.wet)) node.connect(this.output)

    // Echo: repeats that fade out, timed to the beat when the BPM is known.
    this.echoDelay = ctx.createDelay(2)
    this.echoDelay.delayTime.value = 0.375
    const echoFeedback = gain(0.45)
    this.input.connect(this.echoDelay)
    this.echoDelay.connect(echoFeedback)
    echoFeedback.connect(this.echoDelay)
    this.echoDelay.connect(this.wet.echo)

    // Dub: while its button is held, the sound (bass cut away) is thrown into a long, heavy echo
    // that keeps ringing after the button is let go. How it sounds is set in dubSettings.
    this.dubSend = gain(0)
    this.dubThin = ctx.createBiquadFilter()
    this.dubThin.type = 'highpass'
    this.dubDelay = ctx.createDelay(4)
    this.dubDelay.delayTime.value = 0.45
    this.dubFeedback = gain(0.72)
    this.dubDark = ctx.createBiquadFilter() // each repeat a little duller, like tape
    this.dubDark.type = 'lowpass'
    this.dubDark.Q.value = -3 // no resonant bump: the loop must never gain, or the echo grows instead of dying
    this.dubReturn = gain(1)
    this.dubSpring = gain(0)
    const spring = ctx.createConvolver()
    spring.buffer = impulse(ctx, 1.6)
    this.input.connect(this.dubSend)
    this.dubSend.connect(this.dubThin)
    this.dubThin.connect(this.dubDelay)
    this.dubDelay.connect(this.dubDark)
    this.dubDark.connect(this.dubFeedback)
    this.dubFeedback.connect(this.dubDelay)
    this.dubDark.connect(this.dubReturn)
    this.dubReturn.connect(this.output)
    this.dubReturn.connect(spring)
    spring.connect(this.dubSpring)
    this.dubSpring.connect(this.output)
    // Tape wobble: a slow wave bending the echo time.
    this.dubWobble = gain(0)
    const wow = ctx.createOscillator()
    wow.frequency.value = 0.7
    wow.connect(this.dubWobble)
    this.dubWobble.connect(this.dubDelay.delayTime)
    wow.start()
    this.applyDub(dubSettings.get())
    dubSettings.subscribe(() => this.applyDub(dubSettings.get()))

    // Reverb: a room tail.
    const room = ctx.createConvolver()
    room.buffer = impulse(ctx, 2.4)
    this.input.connect(room)
    room.connect(this.wet.reverb)

    // Flanger: a very short delay swept slowly, fed back on itself.
    const sweep = ctx.createDelay(0.02)
    sweep.delayTime.value = 0.004
    lfo(0.3, 0.0025, sweep.delayTime)
    const sweepFeedback = gain(0.55)
    this.input.connect(sweep)
    sweep.connect(sweepFeedback)
    sweepFeedback.connect(sweep)
    sweep.connect(this.wet.flanger)

    // Wah: a narrow band moving up and down the mids; it replaces the dry sound as it is turned up.
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 1000
    band.Q.value = 5
    lfo(1.5, 650, band.frequency)
    this.input.connect(band)
    band.connect(this.wet.wah)
  }

  /** Live settings of the echo itself; they also change a throw that is already ringing. */
  private applyDub(cfg: DubSettings): void {
    const now = this.ctx.currentTime
    this.dubThin.frequency.setTargetAtTime(cfg.lowCut, now, 0.03)
    this.dubDark.frequency.setTargetAtTime(cfg.tone, now, 0.03)
    this.dubReturn.gain.setTargetAtTime(cfg.level, now, 0.03)
    this.dubSpring.gain.setTargetAtTime(cfg.space * 1.4, now, 0.03)
    this.dubWobble.gain.setTargetAtTime(cfg.drift * 0.006, now, 0.05)
    if (this.dubHeld || cfg.release === 'ring') this.dubFeedback.gain.setTargetAtTime(cfg.feedback, now, 0.03)
  }

  /** Dub throw: true while the button is held (or latched). `beat` = seconds per beat as heard. */
  dub(held: boolean, beat: number | null): void {
    const cfg = dubSettings.get()
    const now = this.ctx.currentTime
    this.dubHeld = held
    if (held) {
      const time = (beat && beat > 0.05 ? beat : 0.5) * cfg.beats
      this.dubDelay.delayTime.setTargetAtTime(Math.min(3.9, Math.max(0.03, time)), now, 0.01)
      this.dubFeedback.gain.setTargetAtTime(cfg.feedback, now, 0.01)
    } else if (cfg.release === 'fade') {
      this.dubFeedback.gain.setTargetAtTime(0.2, now, 0.15)
    }
    this.dubSend.gain.setTargetAtTime(held ? 1 : 0, now, 0.01)
    this.dryKill.gain.setTargetAtTime(held && cfg.dry === 'cut' ? 0 : 1, now, held ? 0.008 : 0.03)
  }

  /**
   * @param amount 0..1
   * @param beat seconds per beat as heard, when known (sets the echo time to half a beat)
   */
  apply(type: FxType, on: boolean, amount: number, beat: number | null): void {
    const now = this.ctx.currentTime
    const level: Record<FxType, number> = { echo: 0.8, reverb: 1.8, flanger: 1, wah: 2.2 }
    for (const name of FX) {
      this.wet[name].gain.setTargetAtTime(on && name === type ? amount * level[name] : 0, now, 0.02)
    }
    this.dry.gain.setTargetAtTime(on && type === 'wah' ? 1 - amount * 0.6 : 1, now, 0.02)
    if (beat && beat > 0.05) this.echoDelay.delayTime.setTargetAtTime(Math.min(1.9, beat / 2), now, 0.05)
  }
}
