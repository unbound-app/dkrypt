import { expect, test } from 'bun:test';
import { authRouter } from '#routes/auth.js';
import { billingRouter, nowpaymentsWebhookRouter, stripeWebhookRouter } from '#routes/billing.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { decryptRouter, testFlightDecryptRouter } from '#routes/decrypt.js';
import { buildServer } from '#server.js';
import { getRouteContracts } from '#contracts.js';

test('every registered versioned route has an explicit TypeBox contract', () => {
  const routers = [authRouter, billingRouter, nowpaymentsWebhookRouter, stripeWebhookRouter, dashboardRouter, decryptRouter, testFlightDecryptRouter];
  const routes = routers.flatMap((router) => router.routes.map((route) => `${route.method} ${route.path}`));
  const contracts = getRouteContracts();
  expect(routes.length + 5).toBe(contracts.size);
  for (const route of routes) expect(contracts.has(route)).toBe(true);
  for (const route of ['GET /v1/health', 'GET /v1/status', 'GET /v1/metrics', 'GET /v1/testflight/:appId/trains', 'GET /v1/testflight/:appId/builds']) {
    expect(contracts.has(route)).toBe(true);
  }
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
      ['/v1/dashboard/jobs/bulk-preview', 'post', ['requested', 'eligible', 'projectedQueueAdds', 'items']],
      ['/v1/dashboard/jobs/stats/{bundleId}', 'get', ['bundleId', 'totalRuns', 'successRate', 'failureBreakdown']],
      ['/v1/dashboard/jobs/diff', 'get', ['a', 'b', 'sizeDeltaBytes', 'plistDiff']],
      ['/v1/dashboard/insights', 'get', ['totalRuns', 'topApps', 'trend', 'byDevice', 'anomalies']],
      ['/v1/dashboard/failure-patterns', 'get', ['patterns']],
      ['/v1/dashboard/storage-forecast', 'get', ['freeBytes', 'bytesPerDay', 'daysRemaining', 'sampleCount']],
      ['/v1/dashboard/watches', 'get', ['watches']],
      ['/v1/dashboard/watches/calendar', 'get', ['fromAt', 'untilAt', 'runs', 'truncated']],
      ['/v1/dashboard/github/repos', 'get', ['repos']],
      ['/v1/dashboard/github/workflows', 'get', ['workflows']],
      ['/v1/dashboard/apps/metadata', 'get', ['entries']],
      ['/v1/dashboard/apps/cache', 'get', ['entries', 'icons']],
      ['/v1/dashboard/settings/job-history-retention/preview', 'get', ['retentionDays', 'retained', 'removed', 'artifacts']],
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
    const healthDevice = document.paths?.['/v1/health']?.get?.responses?.['200']?.content?.['application/json']?.schema?.properties?.device as { properties?: Record<string, unknown> } | undefined;
    for (const field of ['transportState', 'capabilities', 'recoveryState', 'subsystems', 'bridgeHeartbeats']) expect(Object.keys(healthDevice?.properties ?? {})).toContain(field);
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
      ['/v1/dashboard/watches', 'post', '201', ['id', 'bundleId', 'pollCron', 'schedulable']],
      ['/v1/dashboard/watches/{id}', 'patch', '200', ['id', 'bundleId', 'pollCron', 'schedulable']],
      ['/v1/dashboard/watches/{id}', 'delete', '200', ['ok']],
      ['/v1/dashboard/watches/import', 'post', '201', ['watches', 'skipped']],
      ['/v1/dashboard/notifications/read', 'post', '200', ['ok', 'marked']],
      ['/v1/dashboard/jobs/{id}/cancel', 'post', '200', ['ok']],
      ['/v1/dashboard/jobs/{id}/prioritize', 'post', '200', ['ok']],
      ['/v1/dashboard/jobs/{id}/retry', 'post', '202', ['id', 'bundleId', 'status', 'statusUrl']],
      ['/v1/dashboard/jobs/reorder', 'post', '200', ['ok']],
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

test('administrative, notification, and diagnostic contracts publish structured responses', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> }> }>>;
    };
    const assertions: Array<[string, string, string, string[]]> = [
      ['/v1/dashboard/logs', 'get', '200', ['logs', 'total', 'nextCursor']],
      ['/v1/dashboard/webhooks', 'get', '200', ['deliveries']],
      ['/v1/dashboard/jobs/{id}/diagnostic', 'get', '200', ['generatedAt', 'correlationId', 'job', 'timeline']],
      ['/v1/dashboard/support-bundle', 'get', '200', ['generatedAt', 'deployment', 'database', 'latestBackup', 'devices', 'jobs']],
      ['/v1/dashboard/github/rate-limit', 'get', '200', ['limit', 'remaining', 'reset']],
      ['/v1/dashboard/discord/status', 'get', '200', ['botEnabled', 'guilds']],
      ['/v1/dashboard/discord/perks', 'get', '200', ['perks']],
      ['/v1/dashboard/discord/perks', 'post', '201', ['id', 'guildId', 'discordRoleId', 'appRoleId']],
      ['/v1/dashboard/backup/export', 'get', '200', ['backupVersion', 'allowedUsers', 'devices', 'billing', 'identities']],
      ['/v1/dashboard/keys/bulk-revoke', 'post', '200', ['revoked']],
      ['/v1/dashboard/keys/bulk-extend-expiry', 'post', '200', ['extended']],
      ['/v1/dashboard/keys/bulk-set-daily-limit', 'post', '200', ['updated']],
      ['/v1/dashboard/keys/bulk-approve', 'post', '200', ['approved']],
      ['/v1/dashboard/keys/{id}/priority', 'patch', '200', ['ok', 'priority']],
      ['/v1/dashboard/keys/{id}/max-concurrent', 'patch', '200', ['ok', 'maxConcurrent']],
      ['/v1/dashboard/keys/{id}/allow-testflight', 'patch', '200', ['ok', 'allowTestFlight']],
      ['/v1/dashboard/me/prefs', 'get', '200', ['theme', 'density', 'preferPrimaryDevice']],
      ['/v1/dashboard/push/public-key', 'get', '200', ['publicKey']],
      ['/v1/dashboard/testflight/diagnostics', 'get', '200', ['bridge']],
      ['/v1/dashboard/watches/{id}/trigger-dispatch', 'post', '202', ['ok', 'error']],
      ['/v1/stripe/webhook', 'post', '200', ['received', 'duplicate']],
      ['/v1/nowpayments/webhook', 'post', '200', ['received', 'duplicate']],
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

test('successful route responses never fall back to generic JSON', () => {
  const exportRoutes = new Set(['GET /v1/dashboard/jobs/export', 'GET /v1/dashboard/audit-log/export']);
  for (const [route, schema] of getRouteContracts()) {
    const responses = schema.response as Record<string, { anyOf?: unknown }> | undefined;
    for (const [status, response] of Object.entries(responses ?? {})) {
      if (status === '200' && response.anyOf) expect(exportRoutes.has(route)).toBe(true);
    }
  }
});

test('response declarations preserve earlier request schemas', () => {
  const login = getRouteContracts().get('POST /v1/auth/login');
  const loginBody = login?.body as { properties?: Record<string, unknown> } | undefined;
  expect(loginBody?.properties).toHaveProperty('password');
  expect(login?.response).toHaveProperty('200');

  const decrypt = getRouteContracts().get('GET /v1/decrypt');
  const decryptQuery = decrypt?.querystring as { properties?: Record<string, unknown> } | undefined;
  expect(decryptQuery?.properties).toHaveProperty('bundleId');
  expect(decrypt?.response).toHaveProperty('200');
});

test('TestFlight catalog contracts include the normalized bridge failure envelope', () => {
  for (const route of ['GET /v1/testflight/:appId/trains', 'GET /v1/testflight/:appId/builds']) {
    const responses = getRouteContracts().get(route)?.response as Record<string, { properties?: Record<string, unknown> }> | undefined;
    for (const field of ['error', 'code', 'message', 'requestId', 'retryable']) {
      expect(Object.keys(responses?.['502']?.properties ?? {})).toContain(field);
    }
  }
});

test('streaming and file responses publish their wire formats', async () => {
  const server = await buildServer({ includePublicRoutes: false });
  try {
    await server.ready();
    const document = server.swagger() as {
      paths?: Record<string, Record<string, { responses?: Record<string, { content?: Record<string, unknown> }> }>>;
    };
    expect(Object.keys(document.paths?.['/v1/dashboard/events']?.get?.responses?.['200']?.content ?? {})).toEqual(['text/event-stream']);
    expect(Object.keys(document.paths?.['/v1/metrics']?.get?.responses?.['200']?.content ?? {})).toEqual(['text/plain']);
    expect(Object.keys(document.paths?.['/v1/artifacts/{id}/file']?.get?.responses?.['200']?.content ?? {})).toEqual(['application/octet-stream']);
    expect(Object.keys(document.paths?.['/v1/dashboard/backup/history/{id}/download']?.get?.responses?.['200']?.content ?? {})).toEqual(['application/octet-stream']);
  } finally {
    await server.close();
  }
});
