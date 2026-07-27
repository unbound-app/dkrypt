import { fetchAppCatalog, refreshAppCatalog as requestAppCatalogRefresh, type AppCatalogEntry, type AppStoreSearchResult } from '#lib/api';

const catalogState = $state<{ byBundleId: Record<string, AppCatalogEntry> }>({ byBundleId: {} });
const inFlight = new Set<string>();

function normalizeBundleIds(bundleIds: string[]): string[] {
  return [...new Set(bundleIds.map((bundleId) => bundleId.trim()).filter(Boolean))];
}

function mergeEntries(entries: AppCatalogEntry[]): void {
  if (entries.length === 0) return;
  const next = { ...catalogState.byBundleId };
  for (const entry of entries) {
    if (!entry.bundleId || !entry.displayName) continue;
    next[entry.bundleId] = entry;
  }
  catalogState.byBundleId = next;
}

export function primeAppCatalogFromSearch(results: AppStoreSearchResult[]): void {
  mergeEntries(
    results.map((result) => ({
      bundleId: result.bundleId,
      displayName: result.trackName,
      iconUrl: result.artworkUrl,
      trackId: result.trackId,
      sellerName: result.sellerName,
      updatedAt: Date.now(),
    })),
  );
}

export async function ensureAppCatalog(bundleIds: string[]): Promise<void> {
  const unique = normalizeBundleIds(bundleIds);
  const missing = unique.filter((bundleId) => !catalogState.byBundleId[bundleId] && !inFlight.has(bundleId));
  if (missing.length === 0) return;

  for (const bundleId of missing) inFlight.add(bundleId);
  try {
    const { entries } = await fetchAppCatalog(missing);
    mergeEntries(entries);
  } catch {
  } finally {
    for (const bundleId of missing) inFlight.delete(bundleId);
  }
}

export async function refreshAppCatalog(bundleIds: string[]): Promise<boolean> {
  const unique = normalizeBundleIds(bundleIds).slice(0, 40);
  if (unique.length === 0) return true;
  const { ok, data } = await requestAppCatalogRefresh(unique);
  if (ok) mergeEntries(data.entries);
  return ok;
}

export function appDisplayName(bundleId: string, fallback?: string): string {
  return catalogState.byBundleId[bundleId]?.displayName ?? fallback ?? bundleId;
}

export function appIconUrl(bundleId: string): string | undefined {
  return catalogState.byBundleId[bundleId]?.iconUrl;
}
