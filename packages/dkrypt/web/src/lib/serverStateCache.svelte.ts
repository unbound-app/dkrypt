export interface ServerQuerySnapshot<T> {
  data: T | undefined;
  error: Error | undefined;
  isFetching: boolean;
  isStale: boolean;
}

interface CacheEntry<T = unknown> extends ServerQuerySnapshot<T> {
  updatedAt: number;
  staleTimeMs: number;
  generation: number;
  clearGeneration: number;
  lastUsedAt: number;
  staleTimer: ReturnType<typeof setTimeout> | undefined;
  promise: Promise<T> | undefined;
  loader: (() => Promise<T>) | undefined;
  listeners: Set<ServerQueryListener<unknown>>;
}

export type ServerQueryListener<T> = (snapshot: ServerQuerySnapshot<T>) => void;

export class ServerQueryCancelledError extends Error {
  constructor() {
    super('Server query was superseded');
    this.name = 'ServerQueryCancelledError';
  }
}

export function isServerQueryCancelled(error: unknown): error is ServerQueryCancelledError {
  return error instanceof ServerQueryCancelledError;
}

export function serverQueryStatus<T>(snapshot: ServerQuerySnapshot<T>): string {
  if (snapshot.data === undefined) return '';
  if (snapshot.error) return 'Refresh failed. Showing the last saved results.';
  if (!snapshot.isStale) return '';
  return snapshot.isFetching ? 'Refreshing saved results…' : 'Saved results may be out of date.';
}

export function mergeServerPage<T extends { id: string }>(
  page: T[],
  loaded: T[],
  previousQueryKey: string,
  nextQueryKey: string,
): T[] {
  if (previousQueryKey !== nextQueryKey) return page;
  const pageIds = new Set(page.map((item) => item.id));
  return [...page, ...loaded.filter((item) => !pageIds.has(item.id))];
}

export class ServerStateCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxEntries: number;
  private recency = 0;

  constructor(maxEntries = 100) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  query<T>(key: string, loader: () => Promise<T>, staleTimeMs = 0): Promise<T> {
    const entry = this.getOrCreate<T>(key);
    entry.lastUsedAt = ++this.recency;
    entry.loader = loader;
    entry.staleTimeMs = staleTimeMs;
    if (entry.data !== undefined && !entry.isStale && Date.now() - entry.updatedAt < staleTimeMs) {
      const clearGeneration = entry.clearGeneration;
      return Promise.resolve().then(() => {
        if (entry.clearGeneration !== clearGeneration) throw new ServerQueryCancelledError();
        return entry.data as T;
      });
    }
    if (entry.promise) return entry.promise;
    return this.load(key, entry, loader);
  }

  observe<T>(key: string, loader: () => Promise<T>, listener: ServerQueryListener<T>, staleTimeMs = 0): () => void {
    const entry = this.getOrCreate<T>(key);
    entry.lastUsedAt = ++this.recency;
    entry.loader = loader;
    entry.staleTimeMs = staleTimeMs;
    const listenerAdapter: ServerQueryListener<unknown> = (snapshot) => listener(snapshot as ServerQuerySnapshot<T>);
    entry.listeners.add(listenerAdapter);
    listener(this.snapshot(entry));
    if (this.isStale(entry)) void this.query(key, loader, staleTimeMs).catch(() => {});
    else this.scheduleStaleNotification(key, entry);
    return () => {
      entry.listeners.delete(listenerAdapter);
      if (entry.listeners.size === 0 && entry.staleTimer) {
        clearTimeout(entry.staleTimer);
        entry.staleTimer = undefined;
      }
      this.evictInactiveEntries();
    };
  }

  getSnapshot<T>(key: string): ServerQuerySnapshot<T> {
    const entry = this.entries.get(key) as CacheEntry<T> | undefined;
    return entry ? this.snapshot(entry) : { data: undefined, error: undefined, isFetching: false, isStale: true };
  }

  invalidatePrefix(prefix: string): void {
    for (const [key, entry] of this.entries) {
      if (!this.matchesPrefix(key, prefix)) continue;
      this.invalidate(key, entry, true);
    }
  }

  invalidateAll(): void {
    for (const [key, entry] of this.entries) this.invalidate(key, entry, true);
  }

  markAllStale(): void {
    for (const entry of this.entries.values()) {
      entry.generation += 1;
      if (entry.staleTimer) clearTimeout(entry.staleTimer);
      entry.staleTimer = undefined;
      entry.promise = undefined;
      entry.isFetching = false;
      entry.isStale = true;
      this.notify(entry);
    }
  }

  clear(): void {
    for (const [key, entry] of this.entries) {
      entry.generation += 1;
      entry.clearGeneration += 1;
      if (entry.staleTimer) clearTimeout(entry.staleTimer);
      entry.staleTimer = undefined;
      entry.data = undefined;
      entry.error = undefined;
      entry.updatedAt = 0;
      entry.promise = undefined;
      entry.isFetching = false;
      entry.isStale = true;
      this.notify(entry);
      if (entry.listeners.size === 0) this.entries.delete(key);
    }
  }

  private getOrCreate<T>(key: string): CacheEntry<T> {
    const existing = this.entries.get(key) as CacheEntry<T> | undefined;
    if (existing) return existing;
    const entry: CacheEntry<T> = {
      data: undefined,
      error: undefined,
      isFetching: false,
      isStale: true,
      updatedAt: 0,
      staleTimeMs: 0,
      generation: 0,
      clearGeneration: 0,
      lastUsedAt: ++this.recency,
      staleTimer: undefined,
      promise: undefined,
      loader: undefined,
      listeners: new Set(),
    };
    this.entries.set(key, entry);
    this.evictInactiveEntries(key);
    return entry;
  }

  private evictInactiveEntries(protectedKey?: string): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | undefined;
      let oldestEntry: CacheEntry | undefined;
      for (const [key, entry] of this.entries) {
        if (key === protectedKey || entry.listeners.size > 0) continue;
        if (!oldestEntry || entry.lastUsedAt < oldestEntry.lastUsedAt) {
          oldestKey = key;
          oldestEntry = entry;
        }
      }
      if (oldestKey === undefined) return;
      this.entries.delete(oldestKey);
    }
  }

  private isStale<T>(entry: CacheEntry<T>): boolean {
    return entry.isStale || entry.data === undefined || Date.now() - entry.updatedAt >= entry.staleTimeMs;
  }

  private load<T>(key: string, entry: CacheEntry<T>, loader: () => Promise<T>): Promise<T> {
    const generation = entry.generation;
    const clearGeneration = entry.clearGeneration;
    entry.loader = loader;
    entry.error = undefined;
    entry.isFetching = true;
    this.notify(entry);

    let pending: Promise<T>;
    pending = Promise.resolve()
      .then(loader)
      .then((data) => {
        if (entry.clearGeneration !== clearGeneration) throw new ServerQueryCancelledError();
        if (this.entries.get(key) === entry && entry.generation === generation) {
          entry.data = data;
          entry.error = undefined;
          entry.updatedAt = Date.now();
          entry.isStale = false;
          this.scheduleStaleNotification(key, entry);
        }
        return data;
      })
      .catch((reason: unknown) => {
        if (this.entries.get(key) === entry && entry.generation === generation) {
          entry.error = reason instanceof Error ? reason : new Error(String(reason));
          entry.isStale = true;
        }
        throw reason;
      })
      .finally(() => {
        if (this.entries.get(key) === entry && entry.generation === generation && entry.promise === pending) {
          entry.promise = undefined;
          entry.isFetching = false;
          this.notify(entry);
        }
      });
    entry.promise = pending;
    return pending;
  }

  private invalidate(key: string, entry: CacheEntry, refetch: boolean): void {
    entry.generation += 1;
    if (entry.staleTimer) clearTimeout(entry.staleTimer);
    entry.staleTimer = undefined;
    entry.promise = undefined;
    entry.isFetching = false;
    entry.isStale = true;
    this.notify(entry);
    if (refetch && entry.listeners.size > 0 && entry.loader) {
      void this.query(key, entry.loader, entry.staleTimeMs).catch(() => {});
    }
  }

  private scheduleStaleNotification(key: string, entry: CacheEntry): void {
    if (entry.listeners.size === 0 || entry.staleTimeMs <= 0 || entry.data === undefined) return;
    if (entry.staleTimer) clearTimeout(entry.staleTimer);
    const generation = entry.generation;
    const delay = Math.max(0, entry.updatedAt + entry.staleTimeMs - Date.now());
    entry.staleTimer = setTimeout(() => {
      entry.staleTimer = undefined;
      if (this.entries.get(key) !== entry || entry.generation !== generation) return;
      entry.isStale = true;
      this.notify(entry);
    }, delay);
  }

  private matchesPrefix(key: string, prefix: string): boolean {
    if (!key.startsWith(prefix)) return false;
    const boundary = key[prefix.length];
    return boundary === undefined || boundary === '?' || boundary === '/' || boundary === '&';
  }

  private snapshot<T>(entry: CacheEntry<T>): ServerQuerySnapshot<T> {
    return {
      data: entry.data,
      error: entry.error,
      isFetching: entry.isFetching,
      isStale: entry.isStale || (entry.data !== undefined && Date.now() - entry.updatedAt >= entry.staleTimeMs),
    };
  }

  private notify<T>(entry: CacheEntry<T>): void {
    const snapshot = this.snapshot(entry);
    for (const listener of entry.listeners) listener(snapshot);
  }
}

export const serverStateCache = new ServerStateCache();
