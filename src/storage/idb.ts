/**
 * Minimal promise wrapper over one IndexedDB object store. Used for the stem-separation
 * model (~170 MB, downloaded once) and per-song stems keyed by file hash. Every call
 * degrades to a no-op/miss when storage is unavailable (private windows, blocked storage).
 */
const DB_NAME = 'stemlight';
const STORE = 'blobs';

let dbPromise: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        // A write only counts once its transaction commits: running out of quota (common in
        // private windows) aborts the transaction after the request itself has succeeded.
        t.oncomplete = () => resolve(req.result);
        t.onabort = t.onerror = () => reject(t.error ?? req.error ?? new Error('IndexedDB transaction failed'));
      }),
  );
}

export async function idbGet<T>(key: string): Promise<T | undefined> {
  try { return await tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>); } catch { return undefined; }
}

export async function idbPut(key: string, value: unknown): Promise<boolean> {
  try {
    await tx('readwrite', (s) => s.put(value, key));
    return true;
  } catch (err) {
    console.warn(`[idb] couldn't store ${key}`, err);
    return false;
  }
}

export async function idbDelete(key: string): Promise<void> {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}

/** Keys starting with `prefix`. */
export async function idbKeys(prefix = ''): Promise<string[]> {
  try {
    const keys = await tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys());
    return keys.map(String).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

/** SHA-256 of a file's bytes, hex. */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
