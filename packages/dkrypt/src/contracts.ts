import { Type, type TSchema } from '@sinclair/typebox';
import type { FastifySchema } from 'fastify';

const BundleId = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });
const VersionSelector = Type.String({ minLength: 1, maxLength: 64, pattern: '^v?\\d+(?:\\.\\d+)*(?:_\\d+)?$' });
const Identifier = Type.String({ minLength: 1, maxLength: 200 });
const EmptyObject = Type.Object({}, { additionalProperties: true });

function object(properties: Record<string, TSchema>): TSchema {
  return Type.Object(properties, { additionalProperties: true });
}

const contracts = new Map<string, FastifySchema>();

function register(method: string, path: string, schema: FastifySchema): void {
  contracts.set(`${method} ${path}`, schema);
}

register('POST', '/v1/decrypts', {
  body: object({ bundleId: BundleId, version: Type.Optional(VersionSelector) }),
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

register('GET', '/v1/testflight/:appId/trains', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ train: Type.Optional(Type.String({ maxLength: 64 })) }) });
register('GET', '/v1/testflight/:appId/builds', { params: object({ appId: Type.String({ minLength: 1, maxLength: 32, pattern: '^\\d+$' }) }), querystring: object({ train: Type.Optional(Type.String({ maxLength: 64 })) }) });

register('POST', '/v1/dashboard/devices/setup', { body: EmptyObject });
register('POST', '/v1/dashboard/devices', { body: EmptyObject });
register('PATCH', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }), body: EmptyObject });
register('DELETE', '/v1/dashboard/devices/:id', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/health', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/preflight', { params: object({ id: Identifier }) });
register('GET', '/v1/dashboard/devices/:id/inventory', { params: object({ id: Identifier }) });
register('PUT', '/v1/dashboard/devices/:id/dark-mode', { params: object({ id: Identifier }), body: object({ enabled: Type.Boolean() }) });
register('POST', '/v1/dashboard/devices/:id/bridge-action', { params: object({ id: Identifier }), body: object({ action: Identifier }) });
register('POST', '/v1/dashboard/devices/:id/recover', { params: object({ id: Identifier }) });

register('POST', '/v1/billing/webhooks/inbox/:id/replay', { params: object({ id: Identifier }) });
register('POST', '/v1/billing/webhooks/inbox/:id/quarantine', { params: object({ id: Identifier }), body: object({ reason: Type.Optional(Type.String({ maxLength: 500 })) }) });

export function getRouteContract(method: string, path: string): FastifySchema | undefined {
  return contracts.get(`${method} ${path}`);
}

export function getRouteContracts(): ReadonlyMap<string, FastifySchema> {
  return contracts;
}
