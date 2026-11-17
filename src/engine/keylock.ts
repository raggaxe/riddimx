/**
 * Key lock for files: the tempo changes, the pitch does not.
 *
 * A file played faster also sounds higher. This node shifts the pitch back by the same amount,
 * using two read heads that glide through a short delay line and cross-fade into each other.
 * It delays the sound by a constant KEYLOCK_LATENCY, whatever the shift.
 */
const WINDOW = 0.05 // seconds
export const KEYLOCK_LATENCY = WINDOW / 2

const WORKLET = `
const WINDOW = ${WINDOW}
class VxPitch extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = 16384
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]
    this.w = 0
    this.phase = 0
    this.ratio = 1
    this.target = 1
    this.port.onmessage = (e) => { this.target = e.data }
  }
  process(inputs, outputs) {
    const input = inputs[0], out = outputs[0]
    if (!input || !input[0]) return true
    const win = WINDOW * sampleRate, mask = this.size - 1
    for (let i = 0; i < input[0].length; i++) {
      this.ratio += (this.target - this.ratio) * 0.002
      const still = Math.abs(this.ratio - 1) < 0.0005
      // The heads move through the delay line at (1 - ratio): that is what changes the pitch.
      if (!still) { this.phase += (1 - this.ratio) / win; this.phase -= Math.floor(this.phase) }
      else this.phase += (0.5 - this.phase) * 0.001 // no shift: settle on one head, mid-window
      const p1 = this.phase, p2 = (this.phase + 0.5) % 1
      const g1 = 0.5 - 0.5 * Math.cos(2 * Math.PI * p1), g2 = 1 - g1
      for (let c = 0; c < out.length; c++) {
        const src = input[c] || input[0], buf = this.buf[c] || this.buf[0]
        buf[this.w] = src[i]
        let y = 0
        for (let h = 0; h < 2; h++) {
          const pos = this.w - (h ? p2 : p1) * win
          const k = Math.floor(pos), f = pos - k
          y += (buf[k & mask] * (1 - f) + buf[(k + 1) & mask] * f) * (h ? g2 : g1)
        }
        out[c][i] = y
      }
      this.w = (this.w + 1) & mask
    }
    return true
  }
}
registerProcessor('vx-pitch', VxPitch)
`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

export async function createPitchShifter(ctx: BaseAudioContext): Promise<AudioWorkletNode> {
  let ready = loaded.get(ctx)
  if (!ready) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
    ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
    loaded.set(ctx, ready)
  }
  await ready
  return new AudioWorkletNode(ctx, 'vx-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] })
}

/** @param ratio pitch factor to apply (1 = none, 0.95 = about a semitone down) */
export function setPitch(node: AudioWorkletNode, ratio: number): void {
  node.port.postMessage(ratio)
}
