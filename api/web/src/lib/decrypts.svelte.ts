import type { TFBuild } from './api';

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
}

function loadDecrypts(): TrackedDecrypt[] {
  try {
    return JSON.parse(localStorage.getItem('myDecrypts') ?? '[]') as TrackedDecrypt[];
  } catch {
    return [];
  }
}

export const myDecryptsState = $state<{ items: TrackedDecrypt[] }>({ items: loadDecrypts() });

function persistDecrypts(): void {
  localStorage.setItem('myDecrypts', JSON.stringify(myDecryptsState.items));
}

export function addDecrypt(entry: TrackedDecrypt): void {
  myDecryptsState.items = [entry, ...myDecryptsState.items];
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
