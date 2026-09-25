import type { TestFlightCatalogApp } from '#lib/api';

export interface TestFlightCatalogStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PersistedTestFlightCatalog {
  apps: TestFlightCatalogApp[];
  fetchedAt: number;
}

const STORAGE_KEY_PREFIX = 'dkrypt:testflight-catalog:v1:';

function browserSessionStorage(): TestFlightCatalogStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

function storageKey(userId: string): string | undefined {
  const normalizedUserId = userId.trim().toLowerCase();
  return normalizedUserId ? `${STORAGE_KEY_PREFIX}${encodeURIComponent(normalizedUserId)}` : undefined;
}

function isTestFlightCatalogApp(value: unknown): value is TestFlightCatalogApp {
  if (!value || typeof value !== 'object') return false;
  const app = value as Record<string, unknown>;
  return Number.isSafeInteger(app.appId)
    && typeof app.bundleId === 'string'
    && typeof app.displayName === 'string'
    && typeof app.lastVerifiedAt === 'number'
    && app.deviceSource === true
    && Array.isArray(app.devices)
    && app.devices.every((device) => Boolean(device)
      && typeof device === 'object'
      && typeof (device as Record<string, unknown>).id === 'string'
      && typeof (device as Record<string, unknown>).name === 'string');
}

export function readPersistedTestFlightCatalog(
  userId: string,
  storage = browserSessionStorage(),
): PersistedTestFlightCatalog | undefined {
  const key = storageKey(userId);
  if (!key || !storage) return undefined;

  try {
    const raw = storage.getItem(key);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.version !== 1 || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.apps) || !value.apps.every(isTestFlightCatalogApp)) return undefined;
    return { apps: value.apps, fetchedAt: value.fetchedAt as number };
  } catch {
    return undefined;
  }
}

export function persistTestFlightCatalog(
  userId: string,
  apps: TestFlightCatalogApp[],
  fetchedAt: number,
  storage = browserSessionStorage(),
): void {
  const key = storageKey(userId);
  if (!key || !storage || !Number.isFinite(fetchedAt)) return;

  try {
    storage.setItem(key, JSON.stringify({ version: 1, apps, fetchedAt }));
  } catch {}
}

export function clearPersistedTestFlightCatalog(userId: string, storage = browserSessionStorage()): void {
  const key = storageKey(userId);
  if (!key || !storage) return;

  try {
    storage.removeItem(key);
  } catch {}
}
