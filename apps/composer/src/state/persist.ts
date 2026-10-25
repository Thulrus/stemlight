import { kvStore, putAll, requestPersistence, sharedAudio } from '@stemlight/storage/idb';
import type { LayoutSnapshot } from '@stemlight/xlights/layout';
import type { Project } from '../model/types';
import type { History } from './store';

/**
 * Local storage for the composer (IndexedDB "stemlight-composer"): projects, their undo
 * history, and small metadata for the recent-projects list. Audio lives in the shared
 * database by content hash, so the timing app can use the same song (handoff).
 */
const STORES = ['projects', 'history', 'meta'] as const;
const projects = kvStore('stemlight-composer', 'projects', STORES);
const histories = kvStore('stemlight-composer', 'history', STORES);
const meta = kvStore('stemlight-composer', 'meta', STORES);

export type RecentEntry = { id: string; name: string; updatedAt: number; durationMs: number; effects: number; rows: number; thumb?: string };
export type StoredAudio = { name: string; type: string; bytes: ArrayBuffer };
export type SavedLayout = { fileName: string; savedAt: number; layout: LayoutSnapshot };

/** Save a project, its undo history and its recent-list entry together (one transaction). */
export async function saveProject(p: Project, history: History, thumb?: string): Promise<boolean> {
  const entry: RecentEntry = {
    id: p.id,
    name: p.name,
    updatedAt: p.updatedAt,
    durationMs: p.audio.durationMs,
    effects: Object.keys(p.effects).length,
    rows: p.rows.length,
    thumb,
  };
  const ok = await putAll('stemlight-composer', STORES, [['projects', p.id, p], ['history', p.id, history], ['meta', `recent:${p.id}`, entry]]);
  void requestPersistence();
  return ok;
}

export async function loadProject(id: string): Promise<{ project: Project; history?: History } | undefined> {
  const project = await projects.get<Project>(id);
  if (!project) return undefined;
  return { project, history: await histories.get<History>(id) };
}

export async function deleteProject(id: string) {
  await projects.delete(id);
  await histories.delete(id);
  await meta.delete(`recent:${id}`);
}

export async function recentProjects(): Promise<RecentEntry[]> {
  const keys = await meta.keys('recent:');
  const entries = await Promise.all(keys.map((k) => meta.get<RecentEntry>(k)));
  return entries.filter((e): e is RecentEntry => !!e).sort((a, b) => b.updatedAt - a.updatedAt);
}

export const saveAudio = (hash: string, a: StoredAudio) => sharedAudio.put(hash, a);
export const loadAudio = (hash: string) => sharedAudio.get<StoredAudio>(hash);

export const saveLastLayout = (l: SavedLayout) => meta.put('layout:last', l);
export const loadLastLayout = () => meta.get<SavedLayout>('layout:last');
