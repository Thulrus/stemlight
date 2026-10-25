/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { hashBytes, idbGet, idbPut } from '@stemlight/storage/idb';
import { gpuHasF16, hasRealGpu, isGpuMemoryError } from './gpu';
import { ctcEmissions } from '../align/acoustic';
import { basicPitchFrames } from '../notes/basicPitch';
import basicPitchUrl from '../notes/basic-pitch.onnx?url';
import { ALIGNER_FILES, HTDEMUCS_FILES, LEAD_FILE, MODEL_CACHE_KEY, ROFORMER_FILE, type ModelFile } from './model';
import type { FromSeparator, SeparatorModel, ToSeparator } from './protocol';
import { LEAD_MODEL, separateRoformer, VOCALS_MODEL } from './roformer';
import { separate } from './separate';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromSeparator, transfer: Transferable[] = []) => self.postMessage(m, transfer);

const sessions: Partial<Record<SeparatorModel, ort.InferenceSession>> = {};
/** Latest job id; a job stops at its next segment once a newer job or a cancel arrives. */
let currentJob = 0;
/** Jobs run one at a time: a session can't run two inferences at once. */
let queue: Promise<void> = Promise.resolve();

/** Fetch one model file with progress, verify its hash, and cache it in IndexedDB. */
async function loadFile(f: ModelFile, onBytes: (n: number) => void): Promise<Uint8Array> {
  const cached = await idbGet<ArrayBuffer>(MODEL_CACHE_KEY(f));
  if (cached && cached.byteLength === f.bytes) {
    onBytes(f.bytes);
    return new Uint8Array(cached);
  }
  const res = await fetch(f.url, { mode: 'cors' }).catch((err) => {
    throw new Error(`couldn’t download ${f.name} (${err instanceof Error ? err.message : String(err)}); check the internet connection and try again`);
  });
  if (!res.ok || !res.body) throw new Error(`couldn’t download ${f.name} (HTTP ${res.status})`);
  const out = new Uint8Array(f.bytes);
  let at = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.length > out.length) throw new Error(`${f.name} is larger than expected`);
    out.set(value, at);
    at += value.length;
    onBytes(value.length);
  }
  if (at !== f.bytes) throw new Error(`${f.name} download was incomplete`);
  if ((await hashBytes(out.buffer)) !== f.sha256) throw new Error(`${f.name} failed its integrity check`);
  await idbPut(MODEL_CACHE_KEY(f), out.buffer);
  return out;
}

async function loadFiles(model: SeparatorModel, files: ModelFile[]): Promise<Uint8Array[]> {
  const total = files.reduce((a, f) => a + f.bytes, 0);
  const cachedAll = (await Promise.all(files.map((f) => idbGet<ArrayBuffer>(MODEL_CACHE_KEY(f))))).every(Boolean);
  let loaded = 0;
  const t0 = performance.now();
  const bytes = await Promise.all(files.map((f) => loadFile(f, (n) => {
    loaded += n;
    post({ type: 'download', model, loaded, total, cached: cachedAll });
  })));
  console.info(`[separator] ${model} model bytes ready in ${(performance.now() - t0).toFixed(0)} ms (cached: ${cachedAll})`);
  return bytes;
}

/** Create a session on WebGPU when a real GPU exists, otherwise multi-threaded WASM. */
async function createSession(model: SeparatorModel, graph: Uint8Array, opts: ort.InferenceSession.SessionOptions, gpuOnly = false, cpuOnly = false) {
  // Multi-threaded WASM needs cross-origin isolation (provided by coi-serviceworker on Pages).
  const threads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.numThreads = threads;
  if (!cpuOnly && (await hasRealGpu())) {
    try {
      const t1 = performance.now();
      const s = await ort.InferenceSession.create(graph, { ...opts, executionProviders: ['webgpu'] });
      console.info(`[separator] ${model} WebGPU session in ${(performance.now() - t1).toFixed(0)} ms`);
      post({ type: 'backend', model, backend: 'webgpu', threads });
      return s;
    } catch (err) {
      console.warn(`[separator] ${model} WebGPU session failed, falling back to WASM`, err);
    }
  }
  if (gpuOnly) throw new Error('needs-gpu');
  const s = await ort.InferenceSession.create(graph, { ...opts, executionProviders: ['wasm'] });
  post({ type: 'backend', model, backend: 'wasm', threads });
  return s;
}

/** Free a model's session (and its GPU buffers). */
async function release(model: SeparatorModel) {
  const s = sessions[model];
  delete sessions[model];
  await s?.release().catch(() => {});
}

async function getSession(model: SeparatorModel, cpuOnly = false): Promise<ort.InferenceSession> {
  const existing = sessions[model];
  if (existing) return existing;
  // Only one model on the GPU at a time: each holds hundreds of MB to a few GB of buffers.
  for (const other of Object.keys(sessions) as SeparatorModel[]) if (other !== model) await release(other);
  if (model === 'htdemucs') {
    const [graph, data] = await loadFiles(model, HTDEMUCS_FILES);
    sessions.htdemucs = await createSession(model, graph, {
      graphOptimizationLevel: 'all',
      externalData: [{ path: HTDEMUCS_FILES[1].name, data }],
    }, false, cpuOnly);
  } else if (model === 'notes') {
    // Basic Pitch is tiny (230 KB) and ships with the app; the CPU is plenty.
    const graph = new Uint8Array(await (await fetch(basicPitchUrl)).arrayBuffer());
    sessions.notes = await createSession(model, graph, { graphOptimizationLevel: 'all' }, false, true);
  } else if (model === 'aligner') {
    // Small enough for the CPU too. fp16 needs a GPU with fp16 shaders; fp32 runs anywhere.
    const f16 = !cpuOnly && (await hasRealGpu()) && (await gpuHasF16());
    const [graph] = await loadFiles(model, [ALIGNER_FILES[f16 ? 'fp16' : 'fp32']]);
    sessions.aligner = await createSession(model, graph, { graphOptimizationLevel: 'all' }, false, cpuOnly);
  } else {
    // RoFormers are ~3x HTDemucs's compute: fine on a GPU, impractically slow on CPU.
    if (!(await hasRealGpu())) throw new Error('needs-gpu');
    const [graph] = await loadFiles(model, [model === 'lead' ? LEAD_FILE : ROFORMER_FILE]);
    sessions[model] = await createSession(model, graph, { graphOptimizationLevel: 'all' }, true);
  }
  return sessions[model]!;
}

// ONNX Runtime's bundled build starts its WASM threads as workers of this same script, named
// "em-pthread". Those must be left to Emscripten, or this handler would swallow their startup
// messages, treat each as a new job, and the threads would never start.
const isOrtThread = self.name?.startsWith('em-pthread');

if (!isOrtThread) self.onmessage = (e: MessageEvent<ToSeparator>) => {
  const msg = e.data;
  const job = ++currentJob;
  if (msg.type === 'cancel') return;
  queue = queue.then(async () => {
    try {
      if (job !== currentJob) throw new Error('cancelled');
      const cancelled = () => job !== currentJob;
      if (msg.type === 'prefetch') {
        // Download, verify and store only; the same choice of files as getSession.
        const files = msg.model === 'htdemucs' ? HTDEMUCS_FILES
          : msg.model === 'aligner' ? [ALIGNER_FILES[(await hasRealGpu()) && (await gpuHasF16()) ? 'fp16' : 'fp32']]
            : [msg.model === 'lead' ? LEAD_FILE : ROFORMER_FILE];
        await loadFiles(msg.model, files);
        const stored = await Promise.all(files.map((f) => idbGet<ArrayBuffer>(MODEL_CACHE_KEY(f)).then(Boolean)));
        if (!stored.every(Boolean)) throw new Error('the browser didn’t allow storing it (private windows often don’t), so it will download again when a song needs it');
        post({ type: 'prefetched', model: msg.model });
      } else if (msg.type === 'separate') {
        let stems;
        try {
          stems = await separate(await getSession('htdemucs', !!msg.cpuOnly), ort.Tensor, msg.left, msg.right, (done, total) => post({ type: 'segment', model: 'htdemucs', done, total }), cancelled);
        } catch (err) {
          // Out of GPU memory (other tabs/apps may hold most of it). This worker's WebGPU state
          // is unusable afterwards, so the app retries in a fresh worker on the CPU.
          if (isGpuMemoryError(err)) throw new Error('needs-gpu-memory');
          throw err;
        }
        post({ type: 'done', stems }, Object.values(stems).map((x) => x.buffer));
      } else if (msg.type === 'notes') {
        const s = await getSession('notes');
        const frames = await basicPitchFrames(s, ort.Tensor, msg.audio, (done, total) => post({ type: 'segment', model: 'notes', done, total }), cancelled);
        post({ type: 'notes', frames }, [frames.note.buffer, frames.onset.buffer, frames.times.buffer]);
      } else if (msg.type === 'emissions') {
        try {
          const s = await getSession('aligner', !!msg.cpuOnly);
          const emissions = await ctcEmissions(s, ort.Tensor, msg.audio16k, (done, total) => post({ type: 'segment', model: 'aligner', done, total }), cancelled);
          post({ type: 'emissions', emissions }, [emissions.logp.buffer]);
        } catch (err) {
          if (isGpuMemoryError(err)) throw new Error('needs-gpu-memory');
          throw err;
        } finally {
          await release('aligner');
        }
      } else {
        const model = msg.type === 'lead' ? 'lead' : 'roformer';
        try {
          const s = await getSession(model);
          const stem = await separateRoformer(model === 'lead' ? LEAD_MODEL : VOCALS_MODEL, s, ort.Tensor, msg.left, msg.right, (done, total) => post({ type: 'segment', model, done, total }), cancelled);
          post(msg.type === 'lead' ? { type: 'lead', lead: stem } : { type: 'vocals-hq', vocals: stem }, [stem.buffer]);
        } catch (err) {
          if (!isGpuMemoryError(err)) throw err;
          console.warn(`[separator] GPU ran out of memory for ${model}`, err);
          throw new Error('needs-gpu-memory');
        } finally {
          await release(model);
        }
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
