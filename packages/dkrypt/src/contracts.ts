import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifySchema } from 'fastify';

const BundleId = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });
const VersionSelector = Type.String({ minLength: 1, maxLength: 64, pattern: '^v?\\d+(?:\\.\\d+)*(?:_\\d+)?$' });
const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const JsonObject = Type.Object({}, { additionalProperties: true });
const JsonResponse = Type.Union([JsonObject, Type.Array(Type.Unknown()), Type.String(), Type.Number(), Type.Boolean(), Type.Null()]);
const ErrorEnvelope = Type.Object(
  {
    error: Type.String(),
    code: Type.String(),
    message: Type.String(),
    requestId: Type.String(),
    retryable: Type.Boolean(),
    remediation: Type.Optional(JsonObject),
  },
  { additionalProperties: true },
);
const PublicStatusState = Type.Union([
  Type.Literal('operational'),
  Type.Literal('degraded'),
  Type.Literal('maintenance'),
  Type.Literal('not_configured'),
  Type.Literal('paused'),
  Type.Literal('unknown'),
]);
const PublicStatusResponse = Type.Object({
  status: Type.Union([Type.Literal('operational'), Type.Literal('degraded'), Type.Literal('maintenance')]),
  checkedAt: Type.String(),
  components: Type.Object({
    service: Type.Object({ state: PublicStatusState }),
    automation: Type.Object({ state: PublicStatusState }),
    scheduler: Type.Object({ state: PublicStatusState }),
  }),
});
const PaginationQuery = object({ cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) });

function object(properties: Record<string, TSchema>): TSchema {
  return Type.Object(properties, { additionalProperties: true });
}

const contracts = new Map<string, FastifySchema>();

function register(method: string, path: string, schema: FastifySchema): void {
  const customResponses = schema.response as Record<string, unknown> | undefined;
  contracts.set(`${method} ${path}`, {
    tags: schema.tags ?? [path.startsWith('/v1/dashboard') ? 'dashboard' : 'public'],
    summary: schema.summary ?? `${method} ${path}`,
    ...schema,
    response: {
      200: JsonResponse,
      400: ErrorEnvelope,
      401: ErrorEnvelope,
      403: ErrorEnvelope,
      404: ErrorEnvelope,
      409: ErrorEnvelope,
      429: ErrorEnvelope,
      500: ErrorEnvelope,
      503: ErrorEnvelope,
      ...customResponses,
    },
  });
}

type ContractMethod = 'DELETE' | 'GET' | 'PATCH' | 'POST' | 'PUT';

function registerGenericContract(method: ContractMethod, path: string): void {
  const parameterNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const schema: FastifySchema = {};
  if (parameterNames.length > 0) {
    schema.params = Type.Object(Object.fromEntries(parameterNames.map((name) => [name, Identifier])), { additionalProperties: false });
  }
  if (method === 'GET') {
    schema.querystring = JsonObject;
  } else if (method !== 'DELETE') {
    schema.body = path.endsWith('/webhook') ? Type.Any() : JsonObject;
  }
  if (path.endsWith('/webhook')) {
    schema.headers = object({
      'stripe-signature': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      'x-nowpayments-sig': Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    });
  }
  register(method, path, schema);
}

register('POST', '/v1/decrypts', {
  body: object({ bundleId: BundleId, version: Type.Optional(VersionSelector) }),
});

register('GET', '/v1/status', {
  tags: ['public'],
  summary: 'Public service status',
  response: { 200: PublicStatusResponse },
});

register('GET', '/v1/decrypt', {
  querystring: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), version: Type.Optional(VersionSelector) }),
});

register('POST', '/v1/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()) }),
});

register('POST', '/v1/billing/checkout', {
  headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
  body: object({ planId: Identifier, provider: Type.Optional(Type.Union([Type.Literal('stripe'), Type.Literal('crypto')])), cryptoAsset: Type.Optional(Type.String({ minLength: 2, maxLength: 32 })) }),
});

register('POST', '/v1/billing/cancel', {
  headers: object({ 'idempotency-key': Type.Optional(Type.String({ minLength: 1, maxLength: 200 })) }),
});
register('GET', '/v1/billing', {});
register('POST', '/v1/billing/portal', {});
register('GET', '/v1/billing/provider-status', {});
register('GET', '/v1/billing/subscriptions', {
  querystring: object({
    ...PaginationQuery.properties,
    q: Type.Optional(Type.String({ maxLength: 200 })),
    provider: Type.Optional(Type.String({ maxLength: 32 })),
    status: Type.Optional(Type.String({ maxLength: 32 })),
    planId: Type.Optional(Identifier),
    from: Type.Optional(Type.String({ maxLength: 64 })),
    to: Type.Optional(Type.String({ maxLength: 64 })),
    wallet: Type.Optional(Type.String({ maxLength: 200 })),
    invoice: Type.Optional(Type.String({ maxLength: 200 })),
  }),
});

register('POST', '/v1/auth/login', { body: object({ password: Type.String({ minLength: 1, maxLength: 500 }), mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }) });
register('POST', '/v1/auth/mfa/confirm', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/verify', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/disable', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/mfa/recovery-codes', { body: object({ token: Type.String({ minLength: 1, maxLength: 100 }) }) });
register('POST', '/v1/auth/reauthenticate', { body: object({ password: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })), mfaToken: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })) }) });
register('POST', '/v1/auth/privacy/delete', { body: object({ confirmation: Type.Literal('DELETE MY ACCOUNT') }) });
register('GET', '/v1/auth/passkeys', {});
register('POST', '/v1/auth/passkeys/options', { body: JsonObject });
register('POST', '/v1/auth/passkeys/verify', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('POST', '/v1/auth/passkeys/reauth/options', {});
register('POST', '/v1/auth/passkeys/reauth/verify', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('POST', '/v1/auth/passkeys/register/options', { body: JsonObject });
register('POST', '/v1/auth/passkeys/register', { body: Type.Record(Type.String({ minLength: 1, maxLength: 120 }), Type.Unknown()) });
register('DELETE', '/v1/auth/passkeys/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });

register('POST', '/v1/dashboard/decrypt', {
  body: object({ bundleId: BundleId, externalVersionId: Type.Optional(Identifier), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), preferPrimary: Type.Optional(Type.Boolean()) }),
});

register('POST', '/v1/dashboard/decrypt/preflight', {
  body: object({ bundleId: BundleId, testflight: Type.Optional(Type.Boolean()), versionLabel: Type.Optional(Type.String({ maxLength: 64 })), installSizeBytes: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), deviceId: Type.Optional(Identifier) }),
});

register('POST', '/v1/dashboard/testflight/decrypt', {
  body: object({ bundleId: BundleId, appId: Type.Union([Type.String({ minLength: 1, maxLength: 32 }), Type.Integer({ minimum: 1 })]), build: Type.Record(Type.String(), Type.Unknown()), deviceId: Type.Optional(Identifier), preferPrimary: Type.Optional(Type.Boolean()) }),
});

register('GET', '/v1/jobs/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/artifacts/:id/file', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/status', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/timeline', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/jobs/:id/diagnostic', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/cancel', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/prioritize', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/jobs/:id/retry', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/notifications', { querystring: PaginationQuery });
register('GET', '/v1/dashboard/jobs', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), source: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('scheduler')])), status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('failed')])), queuedBy: Type.Optional(Type.String({ maxLength: 120 })), deviceId: Type.Optional(Identifier), errorQ: Type.Optional(Type.String({ maxLength: 200 })), failureCategory: Type.Optional(Type.String({ maxLength: 64 })), fromTs: Type.Optional(Type.Integer()), toTs: Type.Optional(Type.Integer()) }) });
register('GET', '/v1/dashboard/artifacts', { querystring: object({ ...PaginationQuery.properties, q: Type.Optional(Type.String({ maxLength: 200 })), channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])) }) });
register('GET', '/v1/dashboard/logs', { querystring: object({ ...PaginationQuery.properties, scope: Type.Optional(Type.String({ maxLength: 100 })), level: Type.Optional(Type.Union([Type.Literal('info'), Type.Literal('warn'), Type.Literal('error')])), q: Type.Optional(Type.String({ maxLength: 100 })), regex: Type.Optional(Type.Literal('1')) }) });
register('GET', '/v1/dashboard/devices/:id/activity', { params: object({ id: Identifier }), querystring: PaginationQuery });
register('GET', '/v1/dashboard/audit-log', { querystring: PaginationQuery });
register('GET', '/v1/dashboard/keys/all', { querystring: object({ ...PaginationQuery.properties, search: Type.Optional(Type.String({ maxLength: 200 })) }) });
register('GET', '/v1/dashboard/webhooks', { querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })) }) });
register('GET', '/v1/dashboard/testflight/subscriptions', { querystring: PaginationQuery });
register('POST', '/v1/dashboard/testflight/subscriptions', { body: object({ url: Type.String({ minLength: 1, maxLength: 500 }) }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/approve', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/deny', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/sync', { params: object({ id: Identifier }) });
register('POST', '/v1/dashboard/testflight/subscriptions/:id/unsubscribe', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/testflight/catalog', { querystring: object({ refresh: Type.Optional(Type.Literal('true')) }) });

register('GET', '/v1/testflight/:appId/trains', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ train: Type.Optional(Type.String({ maxLength: 64 })) }) });
register('GET', '/v1/testflight/:appId/builds', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ train: Type.Optional(Type.String({ maxLength: 64 })) }) });

register('POST', '/v1/dashboard/devices/setup', { body: JsonObject });
register('POST', '/v1/dashboard/devices', { body: JsonObject });
register('PATCH', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }), body: JsonObject });
register('DELETE', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }) });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }) });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: object({ action: Identifier }) });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }) });

register('POST', '/v1/billing/webhooks/inbox/:id/replay', { params: object({ id: Identifier }) });
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', { params: object({ id: Identifier }), body: object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }) });
register('GET', '/v1/billing/webhooks/inbox', { querystring: object({ ...PaginationQuery.properties, status: Type.Optional(Type.String({ maxLength: 32 })), provider: Type.Optional(Type.String({ maxLength: 32 })) }) });

const remainingContracts: Array<[ContractMethod, string]> = [
  ['GET', '/v1/auth/session'],
  ['GET', '/v1/auth/mfa'],
  ['POST', '/v1/auth/mfa/setup'],
  ['GET', '/v1/auth/privacy/export'],
  ['PATCH', '/v1/auth/profile'],
  ['DELETE', '/v1/auth/connections/:provider'],
  ['POST', '/v1/auth/refresh'],
  ['POST', '/v1/auth/logout'],
  ['POST', '/v1/auth/logout-everywhere'],
  ['GET', '/v1/auth/sessions'],
  ['DELETE', '/v1/auth/sessions/:id'],
  ['POST', '/v1/auth/sessions/revoke-others'],
  ['GET', '/v1/auth/github/login'],
  ['GET', '/v1/auth/github/connect'],
  ['GET', '/v1/auth/github/callback'],
  ['GET', '/v1/auth/discord/login'],
  ['GET', '/v1/auth/discord/connect'],
  ['GET', '/v1/auth/discord/callback'],
  ['POST', '/v1/billing/subscription'],
  ['POST', '/v1/nowpayments/webhook'],
  ['POST', '/v1/stripe/webhook'],
  ['GET', '/v1/dashboard/overview'],
  ['GET', '/v1/dashboard/doctor'],
  ['GET', '/v1/dashboard/synthetic'],
  ['POST', '/v1/dashboard/notifications/read'],
  ['GET', '/v1/dashboard/events'],
  ['GET', '/v1/dashboard/artifacts/:id/file'],
  ['GET', '/v1/dashboard/jobs/export'],
  ['GET', '/v1/dashboard/jobs/eta/:bundleId'],
  ['POST', '/v1/dashboard/jobs/bulk-preview'],
  ['GET', '/v1/dashboard/jobs/slo'],
  ['GET', '/v1/dashboard/jobs/stats/:bundleId'],
  ['GET', '/v1/dashboard/jobs/volume'],
  ['GET', '/v1/dashboard/jobs/diff'],
  ['GET', '/v1/dashboard/insights'],
  ['GET', '/v1/dashboard/failure-patterns'],
  ['GET', '/v1/dashboard/storage-forecast'],
  ['GET', '/v1/dashboard/support-bundle'],
  ['GET', '/v1/dashboard/search'],
  ['POST', '/v1/dashboard/testflight/catalog/:bundleId/unsubscribe'],
  ['GET', '/v1/dashboard/apps/metadata'],
  ['GET', '/v1/dashboard/apps/cache'],
  ['POST', '/v1/dashboard/apps/metadata/refresh'],
  ['GET', '/v1/dashboard/versions/:bundleId'],
  ['GET', '/v1/dashboard/devices/discover'],
  ['GET', '/v1/dashboard/devices'],
  ['GET', '/v1/dashboard/github/rate-limit'],
  ['GET', '/v1/dashboard/devices/:id/health-history'],
  ['GET', '/v1/dashboard/devices/:id/battery-history'],
  ['GET', '/v1/dashboard/devices/:id/temperature-history'],
  ['GET', '/v1/dashboard/devices/:id/storage-history'],
  ['GET', '/v1/dashboard/watches'],
  ['GET', '/v1/dashboard/watches/export'],
  ['GET', '/v1/dashboard/watches/health'],
  ['GET', '/v1/dashboard/watches/calendar'],
  ['GET', '/v1/dashboard/github/budget-history'],
  ['GET', '/v1/dashboard/github/repos'],
  ['GET', '/v1/dashboard/github/workflows'],
  ['POST', '/v1/dashboard/watches'],
  ['PATCH', '/v1/dashboard/watches/:id'],
  ['DELETE', '/v1/dashboard/watches/:id'],
  ['POST', '/v1/dashboard/watches/import'],
  ['POST', '/v1/dashboard/watches/preview-dispatch-draft'],
  ['POST', '/v1/dashboard/watches/validate-dispatch-draft'],
  ['GET', '/v1/dashboard/watches/:id/preview-dispatch'],
  ['GET', '/v1/dashboard/watches/:id/preview-dispatch/:source'],
  ['POST', '/v1/dashboard/watches/:id/trigger-dispatch'],
  ['GET', '/v1/dashboard/testflight/:appId/trains'],
  ['GET', '/v1/dashboard/testflight/diagnostics'],
  ['GET', '/v1/dashboard/testflight/:appId/builds'],
  ['POST', '/v1/dashboard/jobs/reorder'],
  ['GET', '/v1/dashboard/keys/mine'],
  ['POST', '/v1/dashboard/keys/request'],
  ['POST', '/v1/dashboard/keys/create'],
  ['POST', '/v1/dashboard/keys/:id/reveal'],
  ['POST', '/v1/dashboard/keys/:id/regenerate'],
  ['DELETE', '/v1/dashboard/keys/:id'],
  ['POST', '/v1/dashboard/keys/bulk-revoke'],
  ['POST', '/v1/dashboard/keys/bulk-extend-expiry'],
  ['POST', '/v1/dashboard/keys/bulk-set-daily-limit'],
  ['POST', '/v1/dashboard/keys/bulk-set-scope'],
  ['GET', '/v1/dashboard/keys/:id/usage'],
  ['GET', '/v1/dashboard/keys/:id/bundle-usage'],
  ['GET', '/v1/dashboard/keys/:id/outcomes'],
  ['GET', '/v1/dashboard/keys/pending'],
  ['POST', '/v1/dashboard/keys/:id/approve'],
  ['POST', '/v1/dashboard/keys/bulk-approve'],
  ['PATCH', '/v1/dashboard/keys/:id/priority'],
  ['PATCH', '/v1/dashboard/keys/:id/max-concurrent'],
  ['PATCH', '/v1/dashboard/keys/:id/allow-testflight'],
  ['POST', '/v1/dashboard/keys/:id/deny'],
  ['GET', '/v1/dashboard/settings'],
  ['PUT', '/v1/dashboard/settings'],
  ['GET', '/v1/dashboard/settings/job-history-retention/preview'],
  ['GET', '/v1/dashboard/settings/validate-cron'],
  ['POST', '/v1/dashboard/settings/test-webhook'],
  ['GET', '/v1/dashboard/users'],
  ['GET', '/v1/dashboard/audit-log/export'],
  ['GET', '/v1/dashboard/roles'],
  ['POST', '/v1/dashboard/roles'],
  ['PATCH', '/v1/dashboard/roles/:id'],
  ['DELETE', '/v1/dashboard/roles/:id'],
  ['POST', '/v1/dashboard/roles/reorder'],
  ['GET', '/v1/dashboard/discord/status'],
  ['GET', '/v1/dashboard/discord/guilds'],
  ['POST', '/v1/dashboard/discord/guilds'],
  ['GET', '/v1/dashboard/discord/roles'],
  ['GET', '/v1/dashboard/discord/perks'],
  ['POST', '/v1/dashboard/discord/perks'],
  ['DELETE', '/v1/dashboard/discord/perks/:id'],
  ['POST', '/v1/dashboard/users'],
  ['PATCH', '/v1/dashboard/users/:username'],
  ['DELETE', '/v1/dashboard/users/:username'],
  ['GET', '/v1/dashboard/backup/export'],
  ['POST', '/v1/dashboard/backup/import'],
  ['POST', '/v1/dashboard/backup/preview'],
  ['POST', '/v1/dashboard/backup/drill'],
  ['GET', '/v1/dashboard/backup/schedule'],
  ['POST', '/v1/dashboard/backup/schedule'],
  ['GET', '/v1/dashboard/backup/history'],
  ['POST', '/v1/dashboard/backup/history'],
  ['GET', '/v1/dashboard/backup/history/:id/download'],
  ['DELETE', '/v1/dashboard/backup/history/:id'],
  ['GET', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/dashboard/push/public-key'],
  ['POST', '/v1/dashboard/push/subscribe'],
  ['POST', '/v1/dashboard/push/unsubscribe'],
  ['POST', '/v1/dashboard/push/test'],
  ['POST', '/v1/dashboard/email/test'],
  ['PUT', '/v1/dashboard/me/prefs'],
  ['GET', '/v1/health'],
  ['GET', '/v1/metrics'],
];

for (const [method, path] of remainingContracts) registerGenericContract(method, path);

register('PATCH', '/v1/auth/profile', { body: object({ displayName: Type.String({ minLength: 1, maxLength: 64 }) }) });
register('DELETE', '/v1/auth/connections/:provider', { params: object({ provider: Type.Union([Type.Literal('github'), Type.Literal('discord')]) }) });
register('POST', '/v1/dashboard/notifications/read', { body: object({ ids: Type.Optional(Type.Array(Identifier, { maxItems: 100 })) }) });
register('POST', '/v1/dashboard/jobs/bulk-preview', { body: object({ ids: Type.Array(Identifier, { maxItems: 100 }) }) });
register('POST', '/v1/stripe/webhook', { headers: object({ 'stripe-signature': Type.String({ minLength: 1, maxLength: 200 }) }), body: Type.Any() });
register('POST', '/v1/nowpayments/webhook', { headers: object({ 'x-nowpayments-sig': Type.String({ minLength: 1, maxLength: 500 }) }), body: Type.Any() });

export function getRouteContract(method: string, path: string): FastifySchema | undefined {
  const key = `${method} ${path}`;
  const current = contracts.get(key);
  if (current) return current;
  throw new Error(`missing route contract for ${key}`);
}

export function getRouteContracts(): ReadonlyMap<string, FastifySchema> {
  return contracts;
}
