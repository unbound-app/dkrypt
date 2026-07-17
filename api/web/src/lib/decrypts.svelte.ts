import type { AppStoreSearchResult, TFBuild } from './api';

export interface TrackedDecrypt {
  id: string;
  bundleId: string;
  trackName: string;
  versionLabel?: string;
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  status: string;
  progress?: string;
  queue?: { position: number; total: number };
  error?: string;
  createdAt: number;
}

const MAX_TRACKED = 30;

function loadDecrypts(): TrackedDecrypt[] {
  try {
    return JSON.parse(localStorage.getItem('myDecrypts') ?? '[]') as TrackedDecrypt[];
  } catch {
    return [];
  }
}

export const myDecryptsState = $state<{ items: TrackedDecrypt[] }>({ items: loadDecrypts() });

function persistDecrypts(): void {
  try {
    localStorage.setItem('myDecrypts', JSON.stringify(myDecryptsState.items));
  } catch {
    // localStorage can throw (quota exceeded, private browsing) - state stays correct in-memory either way.
  }
}

// Bound growth without hiding anything still in flight - drop the oldest finished entries first.
function trimToMax(items: TrackedDecrypt[]): TrackedDecrypt[] {
  if (items.length <= MAX_TRACKED) return items;
  const active = items.filter((d) => d.status !== 'done' && d.status !== 'failed');
  const finished = items.filter((d) => d.status === 'done' || d.status === 'failed');
  const keepFinished = Math.max(0, MAX_TRACKED - active.length);
  const keptFinished = new Set(finished.slice(0, keepFinished).map((d) => d.id));
  return items.filter((d) => d.status !== 'done' && d.status !== 'failed' ? true : keptFinished.has(d.id));
}

export function addDecrypt(entry: Omit<TrackedDecrypt, 'createdAt'> & { createdAt?: number }): void {
  myDecryptsState.items = trimToMax([{ ...entry, createdAt: entry.createdAt ?? Date.now() }, ...myDecryptsState.items]);
  persistDecrypts();
}

export function updateDecrypt(id: string, patch: Partial<TrackedDecrypt>): void {
  myDecryptsState.items = myDecryptsState.items.map((d) => (d.id === id ? { ...d, ...patch } : d));
  persistDecrypts();
}

export function dismissDecrypt(id: string): void {
  myDecryptsState.items = myDecryptsState.items.filter((d) => d.id !== id);
  persistDecrypts();
}

function loadRecentBundleIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem('recentBundleIds') ?? '[]') as string[];
  } catch {
    return [];
  }
}

export const recentBundleIdsState = $state<{ items: string[] }>({ items: loadRecentBundleIds() });

export function pushRecentBundleId(bundleId: string): void {
  const items = [bundleId, ...recentBundleIdsState.items.filter((b) => b !== bundleId)].slice(0, 8);
  recentBundleIdsState.items = items;
  localStorage.setItem('recentBundleIds', JSON.stringify(items));
}

export function removeRecentBundleId(bundleId: string): void {
  const items = recentBundleIdsState.items.filter((b) => b !== bundleId);
  recentBundleIdsState.items = items;
  localStorage.setItem('recentBundleIds', JSON.stringify(items));
}

// Stores the full search result, not just the bundle ID - that's what lets a starred chip show
// the app's real name and jump straight to a decrypt-ready row instead of re-running a search.
// Uses a new key (not the old bare-string-array 'starredBundleIds') since the shape changed; any
// old-format entries just silently fail the type guard below and are dropped.
function loadStarredApps(): AppStoreSearchResult[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('starredApps') ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (a): a is AppStoreSearchResult => !!a && typeof a === 'object' && typeof a.bundleId === 'string' && typeof a.trackName === 'string',
    );
  } catch {
    return [];
  }
}

export const starredAppsState = $state<{ items: AppStoreSearchResult[] }>({ items: loadStarredApps() });

export function isStarredBundleId(bundleId: string): boolean {
  return starredAppsState.items.some((a) => a.bundleId === bundleId);
}

export function toggleStarredApp(app: AppStoreSearchResult): void {
  const items = isStarredBundleId(app.bundleId) ? starredAppsState.items.filter((a) => a.bundleId !== app.bundleId) : [app, ...starredAppsState.items];
  starredAppsState.items = items;
  localStorage.setItem('starredApps', JSON.stringify(items));
}

// Keep tabs in sync - without this, two open dashboard tabs drift apart as each queues/dismisses
// decrypts independently, and only the tab that made the last write wins on next reload.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === 'myDecrypts') myDecryptsState.items = loadDecrypts();
    else if (e.key === 'recentBundleIds') recentBundleIdsState.items = loadRecentBundleIds();
    else if (e.key === 'starredApps') starredAppsState.items = loadStarredApps();
  });
}
