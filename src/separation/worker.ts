/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { hashBytes, idbGet, idbPut } from '../storage/idb';
import { hasRealGpu } from './gpu';
import { HTDEMUCS_FILES, MODEL_CACHE_KEY, ROFORMER_FILE, type ModelFile } from './model';
import type { FromSeparator, SeparatorModel, ToSeparator } from './protocol';
import { separateVocalsRoformer } from './roformer';
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
  const res = await fetch(f.url, { mode: 'cors' });
  if (!res.ok || !res.body) throw new Error(`Model download failed (${res.status}) for ${f.name}`);
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
async function createSession(model: SeparatorModel, graph: Uint8Array, opts: ort.InferenceSession.SessionOptions, gpuOnly = false) {
  // Multi-threaded WASM needs cross-origin isolation (provided by coi-serviceworker on Pages).
  const threads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.numThreads = threads;
  if (await hasRealGpu()) {
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

async function getSession(model: SeparatorModel): Promise<ort.InferenceSession> {
  const existing = sessions[model];
  if (existing) return existing;
  if (model === 'htdemucs') {
    const [graph, data] = await loadFiles(model, HTDEMUCS_FILES);
    sessions.htdemucs = await createSession(model, graph, {
      graphOptimizationLevel: 'all',
      externalData: [{ path: HTDEMUCS_FILES[1].name, data }],
    });
  } else {
    // RoFormer is ~3x HTDemucs's compute: fine on a GPU, impractically slow on CPU.
    if (!(await hasRealGpu())) throw new Error('needs-gpu');
    const [graph] = await loadFiles(model, [ROFORMER_FILE]);
    sessions.roformer = await createSession(model, graph, { graphOptimizationLevel: 'all' }, true);
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
      if (msg.type === 'separate') {
        const s = await getSession('htdemucs');
        const stems = await separate(s, ort.Tensor, msg.left, msg.right, (done, total) => post({ type: 'segment', model: 'htdemucs', done, total }), cancelled);
        post({ type: 'done', stems }, Object.values(stems).map((x) => x.buffer));
      } else {
        const s = await getSession('roformer');
        const vocals = await separateVocalsRoformer(s, ort.Tensor, msg.left, msg.right, (done, total) => post({ type: 'segment', model: 'roformer', done, total }), cancelled);
        post({ type: 'vocals-hq', vocals }, [vocals.buffer]);
      }
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
