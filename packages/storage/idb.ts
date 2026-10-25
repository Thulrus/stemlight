/**
 * Minimal promise wrappers over IndexedDB. Every call degrades to a no-op/miss when storage
 * is unavailable (private windows, blocked storage), so apps keep working without it.
 *
 * Databases are namespaced per app. The timing app keeps its original "stemlight" database
 * (models ~170 MB+ and per-song stems), so existing users don't re-download anything; the
 * composer uses "stemlight-composer", and both share "stemlight-shared" (audio by hash,
 * handoff records).
 */

export type KvStore = {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<boolean>;
  delete(key: string): Promise<void>;
  keys(prefix?: string): Promise<string[]>;
  getAll<T>(): Promise<T[]>;
};

const dbs = new Map<string, Promise<IDBDatabase>>();

function openDb(name: string, stores: readonly string[], version: number): Promise<IDBDatabase> {
  let p = dbs.get(name);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, version);
      req.onupgradeneeded = () => {
        for (const s of stores) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another tab`));
    });
    dbs.set(name, p);
  }
  return p;
}

/**
 * One object store of a database. `stores` lists every store of that database and
 * `version` must be bumped whenever that list grows.
 */
export function kvStore(db: string, store: string, stores: readonly string[] = [store], version = 1): KvStore {
  const tx = <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> =>
    openDb(db, stores, version).then(
      (d) =>
        new Promise<T>((resolve, reject) => {
          const t = d.transaction(store, mode);
          const req = fn(t.objectStore(store));
          // A write only counts once its transaction commits: running out of quota (common in
          // private windows) aborts the transaction after the request itself has succeeded.
          t.oncomplete = () => resolve(req.result);
          t.onabort = t.onerror = () => reject(t.error ?? req.error ?? new Error('IndexedDB transaction failed'));
        }),
    );
  return {
    async get<T>(key: string) {
      try { return await tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>); } catch { return undefined; }
    },
    async put(key: string, value: unknown) {
      try {
        await tx('readwrite', (s) => s.put(value, key));
        return true;
      } catch (err) {
        console.warn(`[idb] couldn't store ${db}/${store}/${key}`, err);
        return false;
      }
    },
    async delete(key: string) {
      try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
    },
    async keys(prefix = '') {
      try {
        const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
        return keys.map(String).filter((k) => k.startsWith(prefix));
      } catch {
        return [];
      }
    },
    async getAll<T>() {
      try { return await tx<T[]>('readonly', (s) => s.getAll() as IDBRequest<T[]>); } catch { return []; }
    },
  };
}

// The timing app's original store.
const legacy = kvStore('stemlight', 'blobs');
export const idbGet = <T>(key: string) => legacy.get<T>(key);
export const idbPut = (key: string, value: unknown) => legacy.put(key, value);
export const idbDelete = (key: string) => legacy.delete(key);
/** Keys starting with `prefix`. */
export const idbKeys = (prefix = '') => legacy.keys(prefix);

/** Shared between the apps: audio by content hash, and handoff records. */
const SHARED_STORES = ['audio', 'handoff'] as const;
export const sharedAudio = kvStore('stemlight-shared', 'audio', SHARED_STORES);
export const sharedHandoff = kvStore('stemlight-shared', 'handoff', SHARED_STORES);

/** SHA-256 of a file's bytes, hex. */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Ask the browser not to evict our data under storage pressure (asked once per page load). */
let persistAsked = false;
export async function requestPersistence(): Promise<boolean> {
  if (persistAsked || !navigator.storage?.persist) return false;
  persistAsked = true;
  try { return (await navigator.storage.persisted()) || (await navigator.storage.persist()); } catch { return false; }
}

export async function storageEstimate(): Promise<{ usage: number; quota: number } | undefined> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : undefined;
  } catch {
    return undefined;
  }
}
