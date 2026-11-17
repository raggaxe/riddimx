/**
 * Reduces an audio stream to a loudness envelope (one RMS value per 128-sample render quantum),
 * computed on the audio thread and delivered in chunks of 64 values.
 */
const WORKLET = `
class VxEnvelope extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(64); this.n = 0 }
  process(inputs) {
    const ch = inputs[0]; const a = ch && ch[0]; let rms = 0
    if (a) {
      const b = ch[1] || a; let sum = 0
      for (let i = 0; i < a.length; i++) { const v = (a[i] + b[i]) * 0.5; sum += v * v }
      rms = Math.sqrt(sum / a.length)
    }
    this.buf[this.n++] = rms
    if (this.n === 64) { this.port.postMessage(this.buf.slice(0)); this.n = 0 }
    return true
  }
}
registerProcessor('vx-envelope', VxEnvelope)
`

export interface EnvelopeTap {
  /** Envelope samples per second. */
  rate: number
  stop(): void
}

export async function tapEnvelope(
  ctx: AudioContext,
  stream: MediaStream,
  onChunk: (chunk: Float32Array) => void,
): Promise<EnvelopeTap> {
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }))
  await ctx.audioWorklet.addModule(url)
  URL.revokeObjectURL(url)
  const source = ctx.createMediaStreamSource(stream)
  const worklet = new AudioWorkletNode(ctx, 'vx-envelope', { numberOfInputs: 1, numberOfOutputs: 1 })
  const silent = ctx.createGain()
  silent.gain.value = 0 // keeps the graph running without sending the capture to the speakers
  source.connect(worklet)
  worklet.connect(silent)
  silent.connect(ctx.destination)
  worklet.port.onmessage = (e) => onChunk(e.data as Float32Array)
  return {
    rate: ctx.sampleRate / 128,
    stop() {
      worklet.port.onmessage = null
      source.disconnect()
      worklet.disconnect()
      silent.disconnect()
    },
  }
}
