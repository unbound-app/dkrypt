import { expect, test } from 'bun:test';
import type { TestFlightCatalogApp } from '#lib/api';
import { clearPersistedTestFlightCatalog, persistTestFlightCatalog, readPersistedTestFlightCatalog, type TestFlightCatalogStorage } from '#lib/testFlightCatalogPersistence';

class MemorySessionStorage implements TestFlightCatalogStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function catalogApp(bundleId: string, lastVerifiedAt: number): TestFlightCatalogApp {
  return {
    appId: 123,
    bundleId,
    displayName: 'Example app',
    devices: [{ id: 'ipad-1', name: 'Lab iPad' }],
    lastVerifiedAt,
    deviceSource: true,
  };
}

test('cached TestFlight apps survive a page reload within the same signed-in account', () => {
  const storage = new MemorySessionStorage();
  const apps = [catalogApp('com.example.app', 1_790_000_000_000)];

  persistTestFlightCatalog('github:adrian', apps, 1_790_000_001_000, storage);

  expect(readPersistedTestFlightCatalog('github:adrian', storage)).toEqual({
    apps,
    fetchedAt: 1_790_000_001_000,
  });
});

test('cached TestFlight apps are isolated by signed-in account', () => {
  const storage = new MemorySessionStorage();

  persistTestFlightCatalog('github:adrian', [catalogApp('com.example.private', 1)], 2, storage);

  expect(readPersistedTestFlightCatalog('github:other', storage)).toBeUndefined();
});

test('clearing a signed-out account does not erase another account cache', () => {
  const storage = new MemorySessionStorage();
  const adrianApps = [catalogApp('com.example.adrian', 1)];
  const otherApps = [catalogApp('com.example.other', 2)];
  persistTestFlightCatalog('github:adrian', adrianApps, 3, storage);
  persistTestFlightCatalog('github:other', otherApps, 4, storage);

  clearPersistedTestFlightCatalog('github:adrian', storage);

  expect(readPersistedTestFlightCatalog('github:adrian', storage)).toBeUndefined();
  expect(readPersistedTestFlightCatalog('github:other', storage)?.apps).toEqual(otherApps);
});

test('malformed cached TestFlight data is ignored', () => {
  const storage = new MemorySessionStorage();
  storage.setItem('dkrypt:testflight-catalog:v1:github%3Aadrian', '{broken');

  expect(readPersistedTestFlightCatalog('github:adrian', storage)).toBeUndefined();
});

test('cached TestFlight records with an invalid app shape are ignored', () => {
  const storage = new MemorySessionStorage();
  storage.setItem('dkrypt:testflight-catalog:v1:github%3Aadrian', JSON.stringify({
    version: 1,
    fetchedAt: 1,
    apps: [{ bundleId: 'com.example.invalid' }],
  }));

  expect(readPersistedTestFlightCatalog('github:adrian', storage)).toBeUndefined();
});
