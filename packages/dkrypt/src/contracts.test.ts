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
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown>; items?: { properties?: Record<string, unknown> } } }> }> }>>;
    };
    const assertions: Array<[string, string, string[]]> = [
      ['/v1/health', 'get', ['ok', 'serviceReady', 'database', 'bridge', 'device']],
      ['/v1/billing', 'get', ['enabled', 'provider', 'plans', 'providers', 'entitlement']],
      ['/v1/dashboard/overview', 'get', ['schedulerEnabled', 'watches', 'devices', 'activeJobs']],
      ['/v1/dashboard/jobs', 'get', ['history', 'total', 'nextCursor']],
      ['/v1/dashboard/artifacts', 'get', ['artifacts', 'total', 'totalBytes', 'maxBytes']],
      ['/v1/dashboard/devices', 'get', ['devices']],
      ['/v1/dashboard/testflight/catalog', 'get', ['apps', 'refreshing']],
      ['/v1/dashboard/search', 'get', ['results']],
      ['/v1/dashboard/testflight/subscriptions', 'get', ['subscriptions', 'total', 'nextCursor']],
      ['/v1/dashboard/decrypt/preflight', 'post', ['bundleId', 'testflight', 'queueLength', 'canQueue', 'devices']],
      ['/v1/dashboard/versions/{bundleId}', 'get', ['versions']],
      ['/v1/dashboard/devices/{id}/inventory', 'get', ['deviceId', 'bundles']],
      ['/v1/dashboard/devices/{id}/dark-mode', 'put', ['reachable', 'checkedAt']],
      ['/v1/dashboard/devices/{id}/bridge-action', 'post', ['result']],
      ['/v1/auth/session', 'get', ['loggedIn', 'identities', 'linkedProviders', 'publicBaseUrl', 'mfa']],
      ['/v1/auth/mfa/verify', 'post', ['ok', 'expiresAt']],
      ['/v1/auth/reauthenticate', 'post', ['ok', 'expiresAt']],
      ['/v1/auth/passkeys', 'get', ['passkeys']],
      ['/v1/auth/passkeys/options', 'post', ['challenge']],
      ['/v1/auth/passkeys/reauth/options', 'post', ['challenge']],
      ['/v1/auth/profile', 'patch', ['displayName', 'linkedProviders']],
      ['/v1/auth/connections/{provider}', 'delete', ['identities', 'linkedProviders']],
      ['/v1/billing/provider-status', 'get', ['stripe', 'crypto']],
      ['/v1/billing/webhooks/inbox', 'get', ['inbox', 'total', 'nextCursor']],
      ['/v1/dashboard/doctor', 'get', ['ok', 'checkedAt', 'checks']],
      ['/v1/dashboard/synthetic', 'get', ['ok', 'checkedAt', 'probes']],
      ['/v1/dashboard/notifications', 'get', ['notifications', 'unread', 'total', 'nextCursor']],
      ['/v1/dashboard/devices/discover', 'get', ['devices', 'scannedNetworks', 'warnings']],
      ['/v1/dashboard/jobs/slo', 'get', ['targetMs', 'historicalP95Ms', 'jobs']],
      ['/v1/decrypts', 'post', ['id', 'bundleId', 'channel', 'status', 'statusUrl', 'selector', 'resolvedVersion', 'artifact']],
      ['/v1/artifacts', 'get', ['artifacts', 'total', 'totalBytes', 'maxBytes', 'nextCursor']],
      ['/v1/artifacts/{id}', 'get', ['id', 'bundleId', 'channel', 'sizeBytes', 'sha256', 'fileUrl']],
      ['/v1/jobs/{id}', 'get', ['id', 'bundleId', 'channel', 'status', 'statusUrl']],
      ['/v1/testflight/{appId}/trains', 'get', ['trains']],
      ['/v1/testflight/{appId}/builds', 'get', ['builds']],
      ['/v1/dashboard/testflight/{appId}/trains', 'get', ['trains']],
      ['/v1/dashboard/testflight/{appId}/builds', 'get', ['builds']],
      ['/v1/billing/checkout', 'post', ['url']],
      ['/v1/billing/cancel', 'post', ['success', 'status', 'provider']],
      ['/v1/dashboard/settings', 'get', ['notifyFormat', 'notifySuccessMode', 'maintenanceMode']],
      ['/v1/dashboard/users', 'get', ['users']],
      ['/v1/dashboard/audit-log', 'get', ['entries', 'total', 'nextCursor']],
      ['/v1/dashboard/roles', 'get', ['roles']],
      ['/v1/dashboard/keys/all', 'get', ['keys', 'total', 'nextCursor']],
      ['/v1/dashboard/backup/schedule', 'get', ['enabled', 'cron', 'retentionCount']],
      ['/v1/dashboard/backup/history', 'get', ['id', 'createdAt', 'filename', 'trigger']],
    ];
    for (const [path, method, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.['200']?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      const properties = schema?.properties ?? schema?.items?.properties ?? {};
      for (const field of fields) expect(Object.keys(properties)).toContain(field);
    }
  } finally {
    await server.close();
  }
});

test('device and TestFlight mutation contracts publish their success status', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const assertions: Array<[string, string, string, string[]]> = [
      ['/v1/dashboard/testflight/subscriptions', 'post', '201', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/approve', 'post', '202', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/deny', 'post', '200', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/sync', 'post', '202', ['subscription']],
      ['/v1/dashboard/testflight/subscriptions/{id}/unsubscribe', 'post', '202', ['subscription']],
      ['/v1/dashboard/devices/setup', 'post', '201', ['device', 'setup']],
      ['/v1/dashboard/devices', 'post', '201', ['id', 'name', 'enabled', 'transport']],
      ['/v1/dashboard/devices/{id}', 'patch', '200', ['id', 'name', 'enabled', 'transport']],
      ['/v1/dashboard/devices/{id}/recover', 'post', '200', ['ok']],
      ['/v1/auth/login', 'post', '200', ['ok']],
      ['/v1/auth/logout', 'post', '200', ['ok']],
      ['/v1/auth/logout-everywhere', 'post', '200', ['ok']],
      ['/v1/auth/sessions/{id}', 'delete', '200', ['ok']],
      ['/v1/auth/sessions/revoke-others', 'post', '200', ['ok', 'revoked']],
      ['/v1/auth/passkeys/register', 'post', '201', ['passkey']],
      ['/v1/auth/passkeys/{id}', 'delete', '200', ['ok']],
      ['/v1/auth/passkeys/verify', 'post', '200', ['ok', 'expiresAt']],
      ['/v1/auth/passkeys/reauth/verify', 'post', '200', ['ok', 'expiresAt']],
      ['/v1/auth/privacy/delete', 'post', '200', ['ok']],
    ];
    for (const [path, method, status, fields] of assertions) {
      const schema = document.paths?.[path]?.[method]?.responses?.[status]?.content?.['application/json']?.schema;
      expect(schema).toBeDefined();
      for (const field of fields) expect(Object.keys(schema?.properties ?? {})).toContain(field);
    }
  } finally {
    await server.close();
  }
});

test('TestFlight build contracts use the trainVersion query parameter', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as { paths?: Record<string, Record<string, { parameters?: Array<{ name?: string; required?: boolean }> }>> };
    for (const path of ['/v1/testflight/{appId}/builds', '/v1/dashboard/testflight/{appId}/builds']) {
      const parameters = document.paths?.[path]?.get?.parameters ?? [];
      const trainVersion = parameters.find((parameter) => parameter.name === 'trainVersion');
      expect(trainVersion?.required).toBe(true);
      expect(parameters.some((parameter) => parameter.name === 'train')).toBe(false);
    }
  } finally {
    await server.close();
  }
});
