import { expect, test } from 'bun:test';
import { authRouter } from '#routes/auth.js';
import { billingRouter, nowpaymentsWebhookRouter, stripeWebhookRouter } from '#routes/billing.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { decryptRouter } from '#routes/decrypt.js';
import { healthRouter } from '#routes/health.js';
import { buildServer } from '#server.js';
import { getRouteContracts } from '#contracts.js';

test('every registered versioned route has an explicit TypeBox contract', () => {
  const routers = [authRouter, billingRouter, nowpaymentsWebhookRouter, stripeWebhookRouter, dashboardRouter, decryptRouter, healthRouter];
  const routes = routers.flatMap((router) => router.routes.map((route) => `${route.method} ${route.path}`));
  const contracts = getRouteContracts();
  expect(routes.length).toBe(contracts.size);
  for (const route of routes) expect(contracts.has(route)).toBe(true);
});

test('every versioned route is represented in generated OpenAPI', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, unknown>> };
    const paths = Object.entries(document.paths ?? {}).filter(([path]) => path.startsWith('/v1/'));
    expect(paths.length).toBeGreaterThan(100);
    for (const [, methods] of paths) {
      expect(Object.keys(methods).length).toBeGreaterThan(0);
      for (const [method, operation] of Object.entries(methods)) {
        const value = operation as { responses?: Record<string, unknown>; requestBody?: { content?: Record<string, { schema?: unknown }> } };
        expect(Object.keys(value.responses ?? {}).length).toBeGreaterThan(0);
        if (method !== 'get' && method !== 'delete' && value.requestBody) {
          const schema = value.requestBody?.content?.['application/json']?.schema;
          expect(schema).toBeDefined();
        }
      }
    }
  } finally {
    await server.close();
  }
});

test('core operational responses publish their required fields', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const assertions: Array<[string, string, string[]]> = [
      ['/v1/health', 'get', ['ok', 'serviceReady', 'database', 'bridge', 'device']],
      ['/v1/billing', 'get', ['enabled', 'provider', 'plans', 'providers', 'entitlement']],
      ['/v1/dashboard/overview', 'get', ['schedulerEnabled', 'watches', 'devices', 'activeJobs']],
      ['/v1/dashboard/jobs', 'get', ['history', 'total', 'nextCursor']],
      ['/v1/dashboard/artifacts', 'get', ['artifacts', 'total', 'totalBytes', 'maxBytes']],
      ['/v1/dashboard/devices', 'get', ['devices']],
      ['/v1/dashboard/testflight/catalog', 'get', ['apps', 'refreshing']],
      ['/v1/auth/session', 'get', ['loggedIn', 'identities', 'linkedProviders', 'publicBaseUrl', 'mfa']],
      ['/v1/billing/provider-status', 'get', ['stripe', 'crypto']],
      ['/v1/billing/webhooks/inbox', 'get', ['inbox', 'total', 'nextCursor']],
      ['/v1/dashboard/doctor', 'get', ['ok', 'checkedAt', 'checks']],
      ['/v1/dashboard/synthetic', 'get', ['ok', 'checkedAt', 'probes']],
      ['/v1/dashboard/notifications', 'get', ['notifications', 'unread', 'total', 'nextCursor']],
      ['/v1/dashboard/devices/discover', 'get', ['devices', 'scannedNetworks', 'warnings']],
      ['/v1/dashboard/jobs/slo', 'get', ['targetMs', 'historicalP95Ms', 'jobs']],
    ];
    for (const [path, method, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      for (const field of fields) expect(Object.keys(schema?.properties ?? {})).toContain(field);
    }
  } finally {
    await server.close();
  }
});
