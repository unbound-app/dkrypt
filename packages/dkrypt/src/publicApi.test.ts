import { expect, test } from 'bun:test';
import { buildServer } from '#server.js';
import { isPublicApiKeyRoute } from '#publicApi.js';
import { createApiKey, revokeApiKey } from '#store/state.js';

test('public OpenAPI contains only decrypt and IPA artifact routes', async () => {
  const server = await buildServer();

  try {
    const response = await server.inject({ method: 'GET', url: '/openapi.json' });
    const document = response.json() as { info?: { description?: string }; paths?: Record<string, Record<string, unknown>> };
    expect(response.statusCode).toBe(200);
    expect(Object.keys(document.paths ?? {}).sort()).toEqual([
      '/v1/artifacts',
      '/v1/artifacts/{id}',
      '/v1/artifacts/{id}/file',
      '/v1/decrypt',
      '/v1/decrypts',
      '/v1/jobs/{id}',
      '/v1/testflight/decrypt',
    ]);
    expect(document.info?.description).toContain('decrypt');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('billing');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/auth');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/dashboard');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/metrics');
    expect(JSON.stringify(document).toLowerCase()).not.toContain('/v1/health');
  } finally {
    await server.close();
  }
});

test('API-key route policy matches concrete job and TestFlight paths only', () => {
  expect(isPublicApiKeyRoute('GET', '/v1/jobs/job-123')).toBe(true);
  expect(isPublicApiKeyRoute('POST', '/v1/testflight/decrypt')).toBe(true);
  expect(isPublicApiKeyRoute('GET', '/v1/testflight/123/builds')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/testflight/123/trains')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/billing')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/billing/checkout')).toBe(false);
  expect(isPublicApiKeyRoute('PUT', '/v1/billing/checkouts')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/auth/session')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/auth/sessions')).toBe(false);
  expect(isPublicApiKeyRoute('GET', '/v1/health')).toBe(false);
  expect(isPublicApiKeyRoute('POST', '/v1/artifacts')).toBe(false);
});

test('generated API keys are rejected outside the decrypt and artifact API allowlist', async () => {
  const apiKey = createApiKey(`Public API boundary ${crypto.randomUUID()}`, 'root');
  const server = await buildServer({ includePublicRoutes: false });
  const headers = { authorization: `Bearer ${apiKey.key}` };

  try {
    const health = await server.inject({ method: 'GET', url: '/v1/health', headers });
    const metrics = await server.inject({ method: 'GET', url: '/v1/metrics', headers });
    const billing = await server.inject({ method: 'GET', url: '/v1/billing', headers });
    const billingCheckout = await server.inject({ method: 'POST', url: '/v1/billing/checkout', headers, payload: {} });
    const billingCheckoutControl = await server.inject({ method: 'PUT', url: '/v1/billing/checkouts', headers, payload: { paused: true } });
    const session = await server.inject({ method: 'GET', url: '/v1/auth/session', headers });
    const sessions = await server.inject({ method: 'GET', url: '/v1/auth/sessions', headers });
    const dashboard = await server.inject({ method: 'GET', url: '/v1/dashboard/overview', headers });
    const status = await server.inject({ method: 'GET', url: '/v1/status', headers });
    const testFlightTrains = await server.inject({ method: 'GET', url: '/v1/testflight/123/trains', headers });
    const testFlightBuilds = await server.inject({ method: 'GET', url: '/v1/testflight/123/builds?trainVersion=1.0', headers });

    expect(health.statusCode).toBe(403);
    expect(metrics.statusCode).toBe(403);
    expect(billing.statusCode).toBe(403);
    expect(billingCheckout.statusCode).toBe(403);
    expect(billingCheckoutControl.statusCode).toBe(403);
    expect(session.statusCode).toBe(403);
    expect(sessions.statusCode).toBe(403);
    expect(dashboard.statusCode).toBe(403);
    expect(status.statusCode).toBe(403);
    expect(testFlightTrains.statusCode).toBe(403);
    expect(testFlightBuilds.statusCode).toBe(403);
  } finally {
    revokeApiKey(apiKey.id, 'root', true);
    await server.close();
  }
});
