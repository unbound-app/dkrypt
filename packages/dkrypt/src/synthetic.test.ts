import { expect, test } from 'bun:test';
import { renderMetrics, resetMetrics } from '#metrics.js';
import { classifyTestFlightCatalogProbe, classifyWebhookProbe, runSyntheticProbe } from '#synthetic.js';

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

test('webhook synthetic checks report missing provider configuration as an error', () => {
  expect(classifyWebhookProbe([{
    name: 'Stripe',
    status: 'misconfigured',
    detail: 'Stripe webhook endpoint is missing required events: invoice.paid, invoice.payment_failed, charge.refunded',
  }], 0)).toEqual({
    status: 'error',
    detail: 'Stripe webhook endpoint is missing required events: invoice.paid, invoice.payment_failed, charge.refunded',
  });
});

test('webhook synthetic checks distinguish temporary provider outages from configuration errors', () => {
  expect(classifyWebhookProbe([{ name: 'Stripe', status: 'unavailable', detail: 'Stripe could not be reached' }], 0)).toEqual({
    status: 'warn',
    detail: 'Stripe could not be reached',
  });
});

test('webhook synthetic checks retain inbox failures while providers are ready', () => {
  expect(classifyWebhookProbe([
    { name: 'Stripe', status: 'ready' },
    { name: 'NOWPayments', status: 'ready' },
  ], 3)).toEqual({
    status: 'warn',
    detail: '3 billing webhook event(s) need attention',
  });
});

test('webhook synthetic checks skip when billing providers are disabled', () => {
  expect(classifyWebhookProbe([], 0)).toEqual({
    status: 'skipped',
    detail: 'No billing webhook provider is configured',
  });
});
