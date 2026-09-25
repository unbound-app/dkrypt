import type { TestFlightCatalogApp } from '#lib/api';

export interface TestFlightCatalogState {
  apps: TestFlightCatalogApp[];
  fetchedAt?: number;
  loading: boolean;
  refreshing: boolean;
  error?: string;
  ownerId?: string;
}

export const testFlightCatalogState = $state<TestFlightCatalogState>({ apps: [], loading: false, refreshing: false });

export function resetTestFlightCatalogState(): void {
  testFlightCatalogState.apps = [];
  testFlightCatalogState.fetchedAt = undefined;
  testFlightCatalogState.loading = false;
  testFlightCatalogState.refreshing = false;
  testFlightCatalogState.error = undefined;
  testFlightCatalogState.ownerId = undefined;
}
