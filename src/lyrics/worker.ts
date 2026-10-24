/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import type { AsrWord } from '../analysis/lyrics';
import { hasRealGpu, isGpuMemoryError } from '../separation/gpu';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import { WHISPER_MODEL, WHISPER_REVISION, type FromLyrics, type ToLyrics } from './protocol';
import { ASR_SR, transcribeVocals } from './transcribe';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromLyrics) => self.postMessage(m);

env.allowLocalModels = false;
// Use the ONNX Runtime WASM we ship (shared with the separator) instead of transformers.js's
// default CDN copy, so the app's code all comes from its own origin.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.wasmPaths = { wasm: ortWasmUrl };
// Models are cached by transformers.js in the browser's Cache Storage.
env.useBrowserCache = true;

let asr: AutomaticSpeechRecognitionPipeline | undefined;
let currentJob = 0;
let queue: Promise<void> = Promise.resolve();

async function getAsr(cpuOnly = false): Promise<AutomaticSpeechRecognitionPipeline> {
  if (asr) return asr;
  if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  const files = new Map<string, { loaded: number; total: number }>();
  const load = (device: 'webgpu' | 'wasm') =>
    pipeline('automatic-speech-recognition', WHISPER_MODEL, {
      revision: WHISPER_REVISION,
      device,
      // 8-bit weights run well on CPU but need kernels WebGPU lacks (they fall back to the CPU
      // inside the GPU session); 4-bit weights use WebGPU's native MatMulNBits.
      dtype: device === 'webgpu' ? { encoder_model: 'q4', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' },
      progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (p.status === 'progress' && p.file && p.total) {
          files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
          let loaded = 0, total = 0;
          for (const f of files.values()) { loaded += f.loaded; total += f.total; }
          post({ type: 'download', loaded, total });
        }
      },
    } as never) as Promise<AutomaticSpeechRecognitionPipeline>;
  const t0 = performance.now();
  let device: 'webgpu' | 'wasm' = !cpuOnly && (await hasRealGpu()) ? 'webgpu' : 'wasm';
  try {
    asr = await load(device);
  } catch (err) {
    if (device !== 'webgpu') throw err;
    console.warn('[lyrics] WebGPU setup failed, using the CPU instead', err);
    device = 'wasm';
    files.clear();
    asr = await load(device);
  }
  console.info(`[lyrics] Whisper ready on ${device} in ${(performance.now() - t0).toFixed(0)} ms`);
  post({ type: 'backend', backend: device });
  return asr;
}

async function transcribe(audio: Float32Array, cpuOnly: boolean, cancelled: () => boolean): Promise<AsrWord[]> {
  try {
    return await transcribeWith(await getAsr(cpuOnly), audio, cancelled);
  } catch (err) {
    // After a WebGPU out-of-memory error this worker's ONNX Runtime state is unusable, so the
    // app retries in a fresh worker on the CPU.
    if (isGpuMemoryError(err)) throw new Error('needs-gpu-memory');
    throw err;
  }
}

async function transcribeWith(pipe: AutomaticSpeechRecognitionPipeline, audio: Float32Array, cancelled: () => boolean): Promise<AsrWord[]> {
  return transcribeVocals(
    audio,
    async (chunk) => {
      const tc = performance.now();
      // A 30 s window of singing is well under 200 tokens; the cap stops Whisper's rare
      // repetition loops from running to its 448-token limit.
      const out = await pipe(chunk, { return_timestamps: 'word', language: 'english', task: 'transcribe', max_new_tokens: 200 } as never);
      console.info(`[lyrics] ${(chunk.length / ASR_SR).toFixed(1)} s window in ${(performance.now() - tc).toFixed(0)} ms`);
      return out as never;
    },
    (done, total) => post({ type: 'progress', done, total }),
    cancelled,
  );
}

// transformers.js bundles ONNX Runtime, whose WASM threads start as workers of this script
// ("em-pthread"); leave those to Emscripten (see separation/worker.ts).
if (!self.name?.startsWith('em-pthread')) self.onmessage = (e: MessageEvent<ToLyrics>) => {
  const msg = e.data;
  const job = ++currentJob;
  if (msg.type === 'cancel') return;
  queue = queue.then(async () => {
    try {
      const words = await transcribe(msg.audio16k, !!msg.cpuOnly, () => job !== currentJob);
      post({ type: 'done', words });
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
