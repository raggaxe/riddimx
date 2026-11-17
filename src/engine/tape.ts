/**
 * Keeps the last few seconds a deck played, so the rewind can play them backwards
 * (the sound of a record being pulled back by hand).
 */
const SECONDS = 4

const WORKLET = `
class VxTape extends AudioWorkletProcessor {
  constructor() {
    super()
    this.size = Math.ceil(sampleRate * ${SECONDS})
    this.buf = [new Float32Array(this.size), new Float32Array(this.size)]
    this.w = 0
    this.filled = 0
    this.port.onmessage = (e) => {
      const n = Math.min(this.filled, Math.floor(e.data * sampleRate))
      const out = [0, 1].map((c) => {
        const a = new Float32Array(n)
        for (let i = 0; i < n; i++) a[i] = this.buf[c][(this.w - n + i + this.size) % this.size]
        return a
      })
      this.port.postMessage(out, [out[0].buffer, out[1].buffer])
    }
  }
  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const left = input[0], right = input[1] || input[0]
    for (let i = 0; i < left.length; i++) {
      this.buf[0][this.w] = left[i]
      this.buf[1][this.w] = right[i]
      this.w = (this.w + 1) % this.size
    }
    this.filled = Math.min(this.size, this.filled + left.length)
    return true
  }
}
registerProcessor('vx-tape', VxTape)
`

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

export class Tape {
  private node: AudioWorkletNode | null = null

  constructor(ctx: AudioContext, source: AudioNode) {
    let ready = loaded.get(ctx)
    if (!ready) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
      ready = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url))
      loaded.set(ctx, ready)
    }
    void ready
      .then(() => {
        // No outputs: it only listens.
        this.node = new AudioWorkletNode(ctx, 'vx-tape', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' })
        source.connect(this.node)
      })
      .catch(() => undefined)
  }

  /** The last `seconds` heard, as [left, right], oldest sample first. Empty if nothing was recorded. */
  last(seconds: number): Promise<Float32Array[]> {
    const node = this.node
    if (!node) return Promise.resolve([new Float32Array(0), new Float32Array(0)])
    return new Promise((resolve) => {
      node.port.onmessage = (e) => resolve(e.data as Float32Array[])
      node.port.postMessage(seconds)
    })
  }
}
