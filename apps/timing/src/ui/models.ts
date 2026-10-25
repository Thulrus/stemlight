import { ALIGNER_FILES, HTDEMUCS_FILES, LEAD_FILE, MODEL_CACHE_KEY, ROFORMER_FILE, type ModelFile } from '../separation/model';
import type { FromSeparator, PrefetchModel, ToSeparator } from '../separation/protocol';
import { gpuHasF16, hasRealGpu } from '../separation/gpu';
import { idbDelete, idbKeys } from '@stemlight/storage/idb';
import { WHISPER_BYTES, WHISPER_GPU_BYTES, WHISPER_MODEL, WHISPER_REVISION, type FromLyrics, type ToLyrics } from '../lyrics/protocol';

/** The models the user can download ahead of time, one per processing option. */
export type ModelId = PrefetchModel | 'whisper';
/** Processing options on the start screen (their localStorage keys). */
export type OptionKey = 'separate' | 'hqVocals' | 'lead' | 'align' | 'lyrics';
export type Gpu = { gpu: boolean; f16: boolean };

export type ModelInfo = {
  id: ModelId;
  option: OptionKey;
  title: string;
  desc: string;
  /** Model name and license-holder, for the curious. */
  model: string;
  /** Under "Separate stems" (needs the separated vocals). */
  sub: boolean;
  gpuOnly: boolean;
  /** Runs on the CPU too, but slowly. */
  gpuPreferred: boolean;
  defaultOn: boolean;
};

export const MODELS: ModelInfo[] = [
  {
    id: 'htdemucs', option: 'separate', sub: false, gpuOnly: false, gpuPreferred: false, defaultOn: true,
    title: 'Separate stems',
    desc: 'Splits the song into drums, bass, vocals and other, for Kick, Snare, Hats, Bass notes, the vocal tracks and the instruments’ melody.',
    model: 'HTDemucs',
  },
  {
    id: 'aligner', option: 'align', sub: true, gpuOnly: false, gpuPreferred: false, defaultOn: true,
    title: 'Precise vocal syllables and lyric timing',
    desc: 'Hears where each sung consonant and vowel starts, for accurate syllables and letter-by-letter lyric alignment.',
    model: 'wav2vec2',
  },
  {
    id: 'roformer', option: 'hqVocals', sub: true, gpuOnly: true, gpuPreferred: true, defaultOn: true,
    title: 'High-quality vocals',
    desc: 'A second, vocals-only model with much cleaner vocals, for better vocal tracks. The standard split can lose unusual voices (opera, heavily processed singing) entirely. About 3× the work of the stem split.',
    model: 'Mel-Band RoFormer',
  },
  {
    id: 'lead', option: 'lead', sub: true, gpuOnly: true, gpuPreferred: true, defaultOn: false,
    title: 'Separate lead and backing vocals',
    desc: 'Syllables follow the lead singer where there is one, and backing vocals get their own tracks (phrases and notes).',
    model: 'BS-RoFormer karaoke',
  },
  {
    id: 'whisper', option: 'lyrics', sub: true, gpuOnly: false, gpuPreferred: true, defaultOn: false,
    title: 'Transcribe lyrics if none are pasted',
    desc: 'Writes down the sung words, which are then aligned to the singing.',
    model: 'Whisper small',
  },
];

/** The files a separator model downloads on this machine (the aligner's precision depends on the GPU). */
function separatorFiles(id: PrefetchModel, g: Gpu): ModelFile[] {
  if (id === 'htdemucs') return HTDEMUCS_FILES;
  if (id === 'roformer') return [ROFORMER_FILE];
  if (id === 'lead') return [LEAD_FILE];
  return [ALIGNER_FILES[g.gpu && g.f16 ? 'fp16' : 'fp32']];
}

/** Approximate download size on this machine. */
export function modelBytes(id: ModelId, g: Gpu): number {
  if (id === 'whisper') return g.gpu ? WHISPER_GPU_BYTES : WHISPER_BYTES;
  return separatorFiles(id, g).reduce((a, f) => a + f.bytes, 0);
}

export const formatMB = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);

let gpuPromise: Promise<Gpu> | undefined;
/** Whether this browser has a usable GPU (WebGPU), checked once. */
export function detectGpu(): Promise<Gpu> {
  gpuPromise ??= (async () => {
    const gpu = await hasRealGpu().catch(() => false);
    return { gpu, f16: gpu && (await gpuHasF16().catch(() => false)) };
  })();
  return gpuPromise;
}

/** Whisper's weights, as transformers.js caches them (see lyrics/worker.ts for the dtypes). */
function whisperUrls(g: Gpu) {
  const suffix = g.gpu ? '_q4' : '_quantized';
  const base = `https://huggingface.co/${WHISPER_MODEL}/resolve/${WHISPER_REVISION}/onnx/`;
  return [`${base}encoder_model${suffix}.onnx`, `${base}decoder_model_merged${suffix}.onnx`];
}
const WHISPER_CACHE = 'transformers-cache';

/** Which models are already stored in this browser. */
export async function cachedModels(g: Gpu): Promise<Set<ModelId>> {
  const keys = new Set(await idbKeys('model:'));
  const out = new Set<ModelId>();
  for (const m of MODELS) {
    if (m.id === 'whisper') continue;
    if (separatorFiles(m.id, g).every((f) => keys.has(MODEL_CACHE_KEY(f)))) out.add(m.id);
  }
  try {
    const cache = await caches.open(WHISPER_CACHE);
    const hits = await Promise.all(whisperUrls(g).map((u) => cache.match(u)));
    if (hits.every(Boolean)) out.add('whisper');
  } catch { /* Cache Storage unavailable */ }
  return out;
}

/** Remove every downloaded model (song caches stay). */
export async function removeModels(): Promise<void> {
  for (const k of await idbKeys('model:')) await idbDelete(k);
  try { await caches.delete(WHISPER_CACHE); } catch { /* ignore */ }
}

export type DownloadState = { id: ModelId; loaded: number; total: number };

/**
 * Downloads models ahead of time, one after another (each is held in memory while it's
 * verified and stored). Uses its own workers, so the app's separation worker is untouched.
 */
export class Downloader {
  private queue: ModelId[] = [];
  private running?: Promise<void>;
  private worker?: Worker;
  private workerKind?: 'separator' | 'lyrics';
  private stopped = false;
  current?: DownloadState;
  error?: string;
  onChange?: () => void;

  get busy() { return !!this.running; }
  queued(id: ModelId) { return this.queue.includes(id) || this.current?.id === id; }

  /** Add models to the queue; resolves when the queue is empty. */
  download(ids: ModelId[]): Promise<void> {
    for (const id of ids) if (!this.queued(id)) this.queue.push(id);
    this.error = undefined;
    this.stopped = false;
    // Ask the browser not to evict hundreds of MB of models under storage pressure.
    void navigator.storage?.persist?.().catch(() => {});
    this.running ??= this.drain().finally(() => { this.running = undefined; this.current = undefined; this.onChange?.(); });
    this.onChange?.();
    return this.running;
  }

  /** Resolves once nothing is downloading. */
  idle(): Promise<void> { return this.running ?? Promise.resolve(); }

  stop() {
    this.stopped = true;
    this.queue = [];
    this.worker?.terminate();
    this.worker = undefined;
    this.onChange?.();
  }

  private async drain() {
    while (this.queue.length && !this.stopped) {
      const id = this.queue.shift()!;
      this.current = { id, loaded: 0, total: modelBytes(id, await detectGpu()) };
      this.onChange?.();
      try {
        await this.fetchOne(id);
      } catch (err) {
        if (this.stopped) break;
        this.error = `Download stopped: ${err instanceof Error ? err.message : String(err)}.`;
        this.queue = [];
      }
    }
    this.worker?.terminate();
    this.worker = undefined;
  }

  private fetchOne(id: ModelId): Promise<void> {
    const whisper = id === 'whisper';
    // Whisper loads through transformers.js in the lyrics worker; the rest share one separator worker.
    if (!this.worker || whisper || this.workerKind !== 'separator') {
      this.worker?.terminate();
      this.workerKind = whisper ? 'lyrics' : 'separator';
      this.worker = whisper
        ? new Worker(new URL('../lyrics/worker.ts', import.meta.url), { type: 'module' })
        : new Worker(new URL('../separation/worker.ts', import.meta.url), { type: 'module' });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const stop = setInterval(() => { if (this.stopped) { clearInterval(stop); reject(new Error('stopped')); } }, 250);
      const done = (err?: Error) => { clearInterval(stop); if (err) reject(err); else resolve(); };
      worker.onmessage = (e: MessageEvent<FromSeparator | FromLyrics>) => {
        const m = e.data;
        if (m.type === 'download') {
          this.current = { id, loaded: m.loaded, total: Math.max(m.total, whisper ? this.current?.total ?? 0 : 0) };
          this.onChange?.();
        } else if (m.type === 'prefetched') done();
        else if (m.type === 'error') done(new Error(m.message));
      };
      worker.onerror = (e) => { e.preventDefault(); done(new Error(e.message || 'the download worker crashed')); };
      if (whisper) worker.postMessage({ type: 'prefetch' } satisfies ToLyrics);
      else worker.postMessage({ type: 'prefetch', model: id } satisfies ToSeparator);
    });
  }
}
