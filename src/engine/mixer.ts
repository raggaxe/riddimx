import { Store, clamp } from '../store'
import { MasterDynamics, cleanDynamics, type Dynamics } from './dynamics'

export interface OutputDevice {
  id: string
  label: string
}

export interface MixerState {
  crossfader: number // 0 = deck A, 1 = deck B
  xfCurve: 'smooth' | 'cut' | 'thru' // crossfader curve: gradual, each side at full almost at once, or off (both through)
  master: number // 0..1
  cueMix: number // headphones: 0 = only the pre-listened decks … 1 = only the master mix
  hpVolume: number // 0..1
  masterDevice: string // output device id, '' = system default
  /** Where the headphones are: '' = off, 'split' = channels 3-4 of the master device, else a device id. */
  hpDevice: string
  devices: OutputDevice[]
  inputs: OutputDevice[] // sound inputs (microphones, the interface's inputs)
  inputDevice: string // input used by the microphone, '' = system default
  splitAvailable: boolean // the master device has at least 4 output channels
  audioError: string | null
  recording: boolean
  recordedAt: number // performance.now() when the recording started
  dynamics: Dynamics // compressor and limiter on the master
  fading: 0 | 1 | null // automatic crossfade running towards deck A (0) or B (1)
}

interface MixerChannel {
  applyOutput(): void
}

const LS = 'vx_audio'
type Saved = Pick<MixerState, 'cueMix' | 'hpVolume' | 'masterDevice' | 'hpDevice' | 'inputDevice' | 'xfCurve' | 'dynamics'>

function saved(): Partial<Saved> {
  try {
    return JSON.parse(localStorage.getItem(LS) || '{}')
  } catch {
    return {}
  }
}

/**
 * Master bus plus the headphone (pre-listen) bus.
 *
 *   decks ──► masterGain (fader) ──► compressor ─► limiter ──► masterOut ──► speakers, recording, meters
 *   decks (pre-fader, when their headphone button is on) ──► cueBus ─┐
 *   masterOut ───────────────────────────────────────────────────────┴─► cue/master mix ─► headphones
 *
 * Headphones can be a second sound device, or outputs 3-4 of a DJ controller's 4-channel sound card.
 */
class Mixer extends Store<MixerState> {
  readonly ctx: AudioContext
  /** Where everything that plays goes in; also the master fader. */
  readonly masterGain: GainNode
  /** The finished master, after the compressor and limiter: what the speakers, headphones and recording get. */
  readonly masterOut: GainNode
  readonly dynamics: MasterDynamics
  /** Decks send their pre-fader signal here while their headphone button is on. */
  readonly cueBus: GainNode
  private hpCue: GainNode
  private hpMaster: GainNode
  private hpOut: GainNode
  private stream: MediaStreamAudioDestinationNode
  private player = new Audio() // plays the headphone bus on a second device
  private split: AudioNode[] = [] // nodes of the 4-channel routing, when active
  private channels: MixerChannel[] = []
  private recorder: MediaRecorder | null = null

  constructor() {
    const s = saved()
    super({
      crossfader: 0.5,
      xfCurve: s.xfCurve === 'cut' || s.xfCurve === 'thru' ? s.xfCurve : 'smooth',
      master: 0.8,
      cueMix: s.cueMix ?? 0,
      hpVolume: s.hpVolume ?? 0.8,
      masterDevice: s.masterDevice ?? '',
      hpDevice: s.hpDevice ?? '',
      devices: [],
      inputs: [],
      inputDevice: s.inputDevice ?? '',
      splitAvailable: false,
      audioError: null,
      recording: false,
      recordedAt: 0,
      dynamics: cleanDynamics(s.dynamics),
      fading: null,
    })
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }))
    this.masterGain = ctx.createGain()
    this.masterGain.gain.value = this.state.master
    this.dynamics = new MasterDynamics(ctx)
    this.masterGain.connect(this.dynamics.input)
    this.masterOut = this.dynamics.output
    this.dynamics.apply(this.state.dynamics)
    this.cueBus = ctx.createGain()
    this.hpCue = ctx.createGain()
    this.hpMaster = ctx.createGain()
    this.hpOut = ctx.createGain()
    this.stream = ctx.createMediaStreamDestination()
    this.cueBus.connect(this.hpCue)
    this.masterOut.connect(this.hpMaster)
    this.hpCue.connect(this.hpOut)
    this.hpMaster.connect(this.hpOut)
    this.masterOut.connect(ctx.destination)
    this.applyHeadphoneLevels()
    navigator.mediaDevices?.addEventListener?.('devicechange', () => void this.refreshDevices())
    void this.restore()
  }

  private async restore(): Promise<void> {
    await this.refreshDevices()
    const has = (id: string): boolean => this.state.devices.some((d) => d.id === id)
    const { masterDevice, hpDevice } = this.state
    await this.setMasterDevice(masterDevice && has(masterDevice) ? masterDevice : '')
    await this.setHeadphoneDevice(hpDevice === 'split' || has(hpDevice) ? hpDevice : '')
  }

  private persist(): void {
    const { cueMix, hpVolume, masterDevice, hpDevice, inputDevice, xfCurve, dynamics } = this.state
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({ cueMix, hpVolume, masterDevice, hpDevice, inputDevice, xfCurve, dynamics } satisfies Saved),
      )
    } catch {
      /* not remembered */
    }
  }

  register(channel: MixerChannel): void {
    this.channels.push(channel)
  }

  /** Browsers start the AudioContext suspended until a user gesture. */
  resume(): void {
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    if (this.player.srcObject && this.player.paused) void this.player.play().catch(() => undefined)
  }

  /** Equal-power crossfader curve, or a cut curve: each side reaches full volume within the first few millimetres. */
  sideGain(side: 0 | 1): number {
    const x = this.state.crossfader
    if (this.state.xfCurve === 'thru') return 1 // crossfader off: both decks go through, the faders decide
    if (this.state.xfCurve === 'cut') return clamp((side === 0 ? 1 - x : x) * 14, 0, 1)
    return side === 0 ? Math.cos((x * Math.PI) / 2) : Math.sin((x * Math.PI) / 2)
  }

  setCrossfaderCurve(xfCurve: 'smooth' | 'cut' | 'thru'): void {
    this.set({ xfCurve })
    this.channels.forEach((c) => c.applyOutput())
    this.persist()
  }

  /** Moved by hand (or MIDI): any automatic fade stops. A hair from the middle snaps to it. */
  setCrossfader(x: number): void {
    this.stopAutoFade()
    this.moveCrossfader(Math.abs(x - 0.5) < 0.015 ? 0.5 : x)
  }

  private moveCrossfader(x: number): void {
    this.set({ crossfader: clamp(x, 0, 1) })
    this.channels.forEach((c) => c.applyOutput())
  }

  private fadeRun = 0

  /**
   * Automatic crossfade to one side over `seconds`, smooth at both ends (ease-in-out).
   * Calling it again for the side it is already heading to stops it where it is.
   */
  autoFade(to: 0 | 1, seconds: number): void {
    if (this.state.fading === to) return this.stopAutoFade()
    this.stopAutoFade()
    const from = this.state.crossfader
    if (Math.abs(from - to) < 0.001) return
    const start = performance.now()
    const ms = Math.max(200, seconds * 1000 * Math.abs(to - from)) // a fade already half done takes half the time
    this.set({ fading: to })
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms)
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
      this.moveCrossfader(from + (to - from) * eased)
      if (t < 1) this.fadeRun = requestAnimationFrame(step)
      else this.set({ fading: null })
    }
    this.fadeRun = requestAnimationFrame(step)
  }

  stopAutoFade(): void {
    cancelAnimationFrame(this.fadeRun)
    if (this.state.fading !== null) this.set({ fading: null })
  }

  setMaster(v: number): void {
    this.set({ master: clamp(v, 0, 1) })
    this.masterGain.gain.setTargetAtTime(this.state.master, this.ctx.currentTime, 0.01)
    this.channels.forEach((c) => c.applyOutput())
  }

  /** Puts an outboard unit (input … output) between the master fader and the compressor. */
  insertPreDynamics(input: AudioNode, output: AudioNode): void {
    this.masterGain.disconnect(this.dynamics.input)
    this.masterGain.connect(input)
    output.connect(this.dynamics.input)
  }

  // ───────────────────────── compressor and limiter ─────────────────────────

  /** Change the master dynamics; turning a knob by hand drops the preset name. */
  setDynamics(change: Partial<Dynamics>): void {
    const touched = Object.keys(change).some((k) => ['threshold', 'ratio', 'attack', 'release', 'makeup'].includes(k))
    const next = cleanDynamics({ ...this.state.dynamics, ...(touched && !('preset' in change) ? { preset: null } : {}), ...change })
    this.set({ dynamics: next })
    this.dynamics.apply(next)
    this.persist()
  }

  // ───────────────────────── recording ─────────────────────────

  /** Record the master mix; stopping saves it as an audio file. */
  toggleRecording(): void {
    if (this.recorder) {
      this.recorder.stop()
      return
    }
    const tap = this.ctx.createMediaStreamDestination()
    this.masterOut.connect(tap)
    const type = 'audio/webm;codecs=opus'
    const recorder = new MediaRecorder(tap.stream, { mimeType: type, audioBitsPerSecond: 256000 })
    const parts: Blob[] = []
    recorder.ondataavailable = (e) => e.data.size && parts.push(e.data)
    recorder.onstop = () => {
      this.masterOut.disconnect(tap)
      this.recorder = null
      this.set({ recording: false })
      const now = new Date()
      const two = (n: number): string => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}h${two(now.getMinutes())}`
      const link = document.createElement('a')
      link.href = URL.createObjectURL(new Blob(parts, { type }))
      link.download = `RiddimX ${stamp}.webm`
      link.click()
      setTimeout(() => URL.revokeObjectURL(link.href), 60000)
    }
    recorder.start(1000)
    this.recorder = recorder
    this.set({ recording: true, recordedAt: performance.now() })
  }

  // ───────────────────────── headphones ─────────────────────────

  setCueMix(v: number): void {
    this.set({ cueMix: clamp(v, 0, 1) })
    this.applyHeadphoneLevels()
    this.persist()
  }

  setHeadphoneVolume(v: number): void {
    this.set({ hpVolume: clamp(v, 0, 1) })
    this.applyHeadphoneLevels()
    this.persist()
  }

  private applyHeadphoneLevels(): void {
    const { cueMix, hpVolume } = this.state
    const now = this.ctx.currentTime
    this.hpCue.gain.setTargetAtTime(Math.cos((cueMix * Math.PI) / 2), now, 0.01)
    this.hpMaster.gain.setTargetAtTime(Math.sin((cueMix * Math.PI) / 2), now, 0.01)
    this.hpOut.gain.setTargetAtTime(hpVolume, now, 0.01)
  }

  /** Three short beeps on the speakers or in the headphones, to check where each output really goes. */
  testTone(where: 'master' | 'phones'): void {
    this.resume()
    const ctx = this.ctx
    const out = ctx.createGain()
    out.gain.value = 0.18
    out.connect(where === 'master' ? this.masterGain : this.hpOut)
    const start = ctx.currentTime + 0.05
    for (let i = 0; i < 3; i++) {
      const t = start + i * 0.22
      const osc = ctx.createOscillator()
      const env = ctx.createGain()
      osc.frequency.value = where === 'master' ? 660 : 880
      env.gain.setValueAtTime(0, t)
      env.gain.linearRampToValueAtTime(1, t + 0.01)
      env.gain.setTargetAtTime(0, t + 0.1, 0.02)
      osc.connect(env).connect(out)
      osc.start(t)
      osc.stop(t + 0.25)
    }
    window.setTimeout(() => out.disconnect(), 1200)
  }

  /** Lists the sound outputs and inputs of this computer. */
  async refreshDevices(): Promise<void> {
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      const list = (kind: MediaDeviceKind, name: string): OutputDevice[] =>
        all
          .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
          .map((d, i) => ({ id: d.deviceId, label: d.label || name + ' ' + (i + 1) }))
      this.set({ devices: list('audiooutput', 'Output'), inputs: list('audioinput', 'Input') })
    } catch {
      this.set({ devices: [], inputs: [] })
    }
  }

  /** Microphone input: '' = system default. Whoever has the microphone open reopens it. */
  setInputDevice(id: string): void {
    this.set({ inputDevice: id })
    this.persist()
  }

  /** What getUserMedia should ask for to use the chosen input (falls back to the default if it is gone). */
  inputConstraint(): { deviceId?: { exact: string } } {
    const id = this.state.inputDevice
    return id && this.state.inputs.some((d) => d.id === id) ? { deviceId: { exact: id } } : {}
  }

  /** Speakers: '' = whatever the system uses by default. */
  async setMasterDevice(id: string): Promise<void> {
    try {
      await (this.ctx as any).setSinkId(id)
      this.set({ masterDevice: id, audioError: null })
    } catch {
      this.set({ audioError: 'Não deu para usar esse output no master.' })
    }
    const splitAvailable = this.ctx.destination.maxChannelCount >= 4
    this.set({ splitAvailable })
    // The 4-channel routing depends on the master device: rebuild it, or drop it if no longer possible.
    if (this.state.hpDevice === 'split') await this.setHeadphoneDevice(splitAvailable ? 'split' : '')
    this.persist()
  }

  /** Headphones: '' off · 'split' = outputs 3-4 of the master device · otherwise another device. */
  async setHeadphoneDevice(id: string): Promise<void> {
    const dest = this.ctx.destination
    // Back to the plain stereo routing first.
    const unlink = (to: AudioNode): void => {
      try {
        this.masterOut.disconnect(to)
      } catch {
        /* was not connected */
      }
    }
    this.hpOut.disconnect()
    unlink(dest)
    if (this.split.length) unlink(this.split[1])
    this.split.forEach((n) => n.disconnect())
    this.split = []
    this.player.pause()
    this.player.srcObject = null
    if (dest.channelCount !== 2) {
      dest.channelCount = 2
      dest.channelInterpretation = 'speakers'
    }
    let error: string | null = null

    if (id === 'split' && dest.maxChannelCount >= 4) {
      dest.channelCount = 4
      dest.channelCountMode = 'explicit'
      dest.channelInterpretation = 'discrete'
      const merger = this.ctx.createChannelMerger(4)
      const fromMaster = this.ctx.createChannelSplitter(2)
      const fromPhones = this.ctx.createChannelSplitter(2)
      this.masterOut.connect(fromMaster)
      this.hpOut.connect(fromPhones)
      fromMaster.connect(merger, 0, 0)
      fromMaster.connect(merger, 1, 1)
      fromPhones.connect(merger, 0, 2)
      fromPhones.connect(merger, 1, 3)
      merger.connect(dest)
      this.split = [merger, fromMaster, fromPhones]
      // masterOut also feeds hpMaster; only its link to fromMaster belongs to this routing.
    } else {
      this.masterOut.connect(dest)
      if (id === 'split') {
        id = ''
        error = 'O output do master não tem canais 3-4.'
      } else if (id) {
        try {
          this.hpOut.connect(this.stream)
          this.player.srcObject = this.stream.stream
          await (this.player as any).setSinkId(id)
          await this.player.play()
        } catch {
          this.hpOut.disconnect()
          this.player.srcObject = null
          id = ''
          error = 'Não deu para usar esse output no headphone.'
        }
      }
    }
    this.set({ hpDevice: id, audioError: error })
    this.persist()
  }
}

export const mixer = new Mixer()
