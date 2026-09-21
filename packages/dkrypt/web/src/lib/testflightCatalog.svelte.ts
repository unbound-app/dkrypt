import { fetchTestFlightCatalog, type TestFlightCatalogApp } from '#lib/api';

export const testFlightCatalogState = $state<{
  apps: TestFlightCatalogApp[];
  fetchedAt?: number;
  loading: boolean;
  refreshing: boolean;
  error?: string;
}>({ apps: [], loading: false, refreshing: false });

let loaded = false;
let loadPromise: Promise<void> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleRefresh(delay = 2_000): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    pollTimer = undefined;
    void loadCatalog(false, true);
  }, delay);
}

async function loadCatalog(force: boolean, ignoreLoaded: boolean): Promise<void> {
  if (loadPromise) await loadPromise;
  if (!force && !ignoreLoaded && loaded) return;

  testFlightCatalogState.loading = testFlightCatalogState.apps.length === 0;
  loadPromise = fetchTestFlightCatalog(force)
    .then((data) => {
      testFlightCatalogState.apps = data.apps;
      testFlightCatalogState.fetchedAt = data.fetchedAt;
      testFlightCatalogState.refreshing = data.refreshing === true;
      testFlightCatalogState.error = undefined;
      loaded = true;
      if (testFlightCatalogState.refreshing) scheduleRefresh();
      else scheduleRefresh(5 * 60_000);
    })
    .catch((error) => {
      testFlightCatalogState.error = error instanceof Error ? error.message : String(error);
      testFlightCatalogState.refreshing = false;
      loaded = false;
      scheduleRefresh(2 * 60_000);
    })
    .finally(() => {
      testFlightCatalogState.loading = false;
      loadPromise = undefined;
    });
  return loadPromise;
}

export function loadTestFlightCatalog(force = false): Promise<void> {
  return loadCatalog(force, false);
}
