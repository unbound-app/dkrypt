import { expect, test } from 'bun:test';
import { renderMetrics, resetMetrics } from '#metrics.js';
import { classifyTestFlightCatalogProbe, runSyntheticProbe } from '#synthetic.js';

test('synthetic probe failures count returned error states', async () => {
  resetMetrics();

  try {
    const result = await runSyntheticProbe('database', async () => ({ status: 'error', detail: 'integrity check failed' }));

    expect(result).toMatchObject({ id: 'database', status: 'error', detail: 'integrity check failed' });
    expect(renderMetrics()).toContain('dkrypt_synthetic_probe_failures_total{probe="database"} 1');
  } finally {
    resetMetrics();
  }
});

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
