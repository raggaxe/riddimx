/// <reference lib="webworker" />
/**
 * Runs the stem separator off the page's thread: the ONNX model on the Mac's GPU (WebGPU, over
 * Metal) when it can, else on the processor (WebAssembly, all cores). Same result either way.
 * In:  { id, left, right }  (float32 at 44.1 kHz)
 * Out: { id, engine } · { id, progress } · { id, stems } · { id, error }
 */
import * as ort from 'onnxruntime-web/webgpu'
import { separate, SOURCES, MODEL_URL } from './demucs'
import ortMjs from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs?url'
import ortWasm from '../../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm?url'

// The engine's WebAssembly files, served by the app itself (dev server and packaged build alike).
ort.env.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm }
ort.env.wasm.numThreads = Math.max(1, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1))

let session: Promise<{ s: ort.InferenceSession; engine: string }> | null = null

function open(): Promise<{ s: ort.InferenceSession; engine: string }> {
  session ??= (async () => {
    const tries: [string, ort.InferenceSession.SessionOptions][] = [
      ['GPU', { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' }],
      ['CPU', { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }],
    ]
    const errors: string[] = []
    for (const [engine, options] of tries) {
      if (engine === 'GPU' && !('gpu' in self.navigator)) continue
      try {
        return { s: await ort.InferenceSession.create(MODEL_URL, options), engine }
      } catch (e) {
        errors.push(engine + ': ' + String((e as Error)?.stack ?? e))
      }
    }
    throw new Error(errors.join(' | ') || 'no engine')
  })()
  return session
}

self.onmessage = async (e: MessageEvent<{ id: string; left: Float32Array; right: Float32Array }>) => {
  const { id, left, right } = e.data
  try {
    const { s, engine } = await open()
    self.postMessage({ id, engine })
    const run = async (mix: Float32Array, mag: Float32Array) => {
      const out = await s.run({
        mix: new ort.Tensor('float32', mix, [1, 2, mix.length / 2]),
        mag: new ort.Tensor('float32', mag, [1, 4, 2048, mag.length / (4 * 2048)]),
      })
      return { spec: out.spec.data as Float32Array, wave: out.wave.data as Float32Array }
    }
    const stems = await separate(left, right, run, (progress) => self.postMessage({ id, progress }))
    self.postMessage(
      { id, stems },
      SOURCES.map((name) => stems[name].buffer as ArrayBuffer),
    )
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
