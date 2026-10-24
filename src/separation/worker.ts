/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/webgpu';
import { hashBytes, idbGet, idbPut } from '../storage/idb';
import { HTDEMUCS_FILES, MODEL_CACHE_KEY, MODEL_TOTAL_BYTES, type ModelFile } from './model';
import type { FromSeparator, ToSeparator } from './protocol';
import { separate } from './separate';

declare const self: DedicatedWorkerGlobalScope;
const post = (m: FromSeparator, transfer: Transferable[] = []) => self.postMessage(m, transfer);

let session: ort.InferenceSession | undefined;
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

/**
 * True when WebGPU is backed by real hardware. Browsers can expose navigator.gpu with no
 * adapter, or with a software fallback (SwiftShader) that is far slower than WASM.
 */
async function hasRealGpu(): Promise<boolean> {
  if (!('gpu' in navigator)) return false;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null);
  if (!adapter) return false;
  const info = adapter.info as GPUAdapterInfo & { isFallbackAdapter?: boolean };
  const software = /swiftshader|llvmpipe|lavapipe|software/i.test(`${info.vendor} ${info.architecture} ${info.description}`);
  console.info(`[separator] WebGPU adapter: ${info.vendor} ${info.architecture}${software || info.isFallbackAdapter ? ' (software, skipped)' : ''}`);
  return !software && !info.isFallbackAdapter;
}

async function getSession(): Promise<ort.InferenceSession> {
  if (session) return session;
  let loaded = 0;
  const cachedAll = (await Promise.all(HTDEMUCS_FILES.map((f) => idbGet<ArrayBuffer>(MODEL_CACHE_KEY(f))))).every(Boolean);
  const report = (n: number) => {
    loaded += n;
    post({ type: 'download', loaded, total: MODEL_TOTAL_BYTES, cached: cachedAll });
  };
  const t0 = performance.now();
  const [graph, data] = await Promise.all(HTDEMUCS_FILES.map((f) => loadFile(f, report)));
  console.info(`[separator] model bytes ready in ${(performance.now() - t0).toFixed(0)} ms (cached: ${cachedAll})`);

  // Multi-threaded WASM needs cross-origin isolation (provided by coi-serviceworker on Pages).
  const threads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  ort.env.wasm.numThreads = threads;
  const opts = (ep: 'webgpu' | 'wasm'): ort.InferenceSession.SessionOptions => ({
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    externalData: [{ path: HTDEMUCS_FILES[1].name, data }],
  });
  if (await hasRealGpu()) {
    try {
      const t1 = performance.now();
      session = await ort.InferenceSession.create(graph, opts('webgpu'));
      console.info(`[separator] WebGPU session in ${(performance.now() - t1).toFixed(0)} ms`);
      post({ type: 'backend', backend: 'webgpu', threads });
      return session;
    } catch (err) {
      console.warn('WebGPU session failed, falling back to WASM', err);
    }
  }
  const t2 = performance.now();
  session = await ort.InferenceSession.create(graph, opts('wasm'));
  console.info(`[separator] WASM session (${threads} threads) in ${(performance.now() - t2).toFixed(0)} ms`);
  post({ type: 'backend', backend: 'wasm', threads });
  return session;
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
      const s = await getSession();
      const stems = await separate(s, ort.Tensor, msg.left, msg.right, (done, total) => post({ type: 'segment', done, total }), () => job !== currentJob);
      post({ type: 'done', stems }, Object.values(stems).map((x) => x.buffer));
    } catch (err) {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  });
};
