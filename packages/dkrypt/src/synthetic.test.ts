import { expect, test } from 'bun:test';
import { classifyTestFlightCatalogProbe } from '#synthetic.js';

test('TestFlight synthetic checks report missing and stale verification without claiming readiness', () => {
  expect(classifyTestFlightCatalogProbe({ apps: [], stale: true, refreshing: false })).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('did not launch TestFlight'),
  });
  expect(classifyTestFlightCatalogProbe({ apps: [], fetchedAt: 1, stale: true, refreshing: false })).toMatchObject({
    status: 'warn',
    detail: expect.stringContaining('is stale'),
  });
});

test('TestFlight synthetic checks report recent cached device verification as ready', () => {
  expect(classifyTestFlightCatalogProbe({
    apps: [{ appId: 1 } as never],
    fetchedAt: Date.now(),
    stale: false,
    refreshing: false,
  })).toMatchObject({
    status: 'ok',
    detail: expect.stringContaining('1 app(s) recently verified on device'),
  });
});
