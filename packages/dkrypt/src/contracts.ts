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

function fallbackContract(method: string, path: string): FastifySchema {
  const parameterNames = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  const schema: FastifySchema = {
    tags: [path.startsWith('/v1/dashboard') ? 'dashboard' : 'public'],
    summary: `${method} ${path}`,
    response: { 200: JsonResponse, 400: ErrorEnvelope, 401: ErrorEnvelope, 403: ErrorEnvelope, 404: ErrorEnvelope, 409: ErrorEnvelope, 429: ErrorEnvelope, 500: ErrorEnvelope, 503: ErrorEnvelope },
  };
  if (parameterNames.length > 0) {
    schema.params = Type.Object(Object.fromEntries(parameterNames.map((name) => [name, Type.String({ minLength: 1, maxLength: 200 })])), { additionalProperties: false });
  }
  if (method === 'GET') schema.querystring = JsonObject;
  if (method !== 'GET') schema.body = JsonObject;
  return schema;
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

export function getRouteContract(method: string, path: string): FastifySchema | undefined {
  const key = `${method} ${path}`;
  const current = contracts.get(key);
  if (current) return current;
  const generated = fallbackContract(method, path);
  contracts.set(key, generated);
  return generated;
}

export function getRouteContracts(): ReadonlyMap<string, FastifySchema> {
  return contracts;
}
