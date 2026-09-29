import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema, identifierSchema, paginationQueryProperties, projectIdentifierSchema } from '#apiCommonContracts.js';

const additionalProperties = { additionalProperties: true } as const;

export const dashboardArtifactListQuerySchema = Type.Object({
  ...paginationQueryProperties,
  projectId: Type.Optional(projectIdentifierSchema),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  channel: Type.Optional(Type.Union([Type.Literal('appstore'), Type.Literal('testflight')])),
  archived: Type.Optional(Type.Boolean()),
}, additionalProperties);

export const dashboardArtifactResponseSchema = Type.Object({
  id: identifierSchema,
  key: Type.String(),
  bundleId: bundleIdSchema,
  channel: Type.Union([Type.Literal('appstore'), Type.Literal('testflight')]),
  externalVersionId: Type.Optional(identifierSchema),
  testflightBuildId: Type.Optional(Type.Integer({ minimum: 1 })),
  versionLabel: Type.Optional(Type.String()),
  buildNumber: Type.Optional(Type.String()),
  fileSizeBytes: Type.Number({ minimum: 0 }),
  sha256: Type.String({ minLength: 64, maxLength: 64 }),
  createdAt: Type.String({ format: 'date-time' }),
  lastAccessedAt: Type.String({ format: 'date-time' }),
  accessCount: Type.Integer({ minimum: 0 }),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
  archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
  sourceJobId: Type.Optional(identifierSchema),
  warnings: Type.Optional(Type.Array(Type.String())),
  fileUrl: Type.String(),
}, additionalProperties);

export const dashboardArtifactListResponseSchema = Type.Object({
  artifacts: Type.Array(dashboardArtifactResponseSchema),
  total: Type.Integer({ minimum: 0 }),
  totalBytes: Type.Number({ minimum: 0 }),
  maxBytes: Type.Number({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, additionalProperties);

export const dashboardArtifactParamsSchema = Type.Object({ id: identifierSchema }, additionalProperties);

export const dashboardArtifactPinBodySchema = Type.Object({ pinned: Type.Boolean() }, additionalProperties);

export const dashboardArtifactPinResponseSchema = Type.Object({
  ok: Type.Boolean(),
  artifactId: identifierSchema,
  pinned: Type.Boolean(),
  pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
}, additionalProperties);

export const dashboardArtifactBulkPinBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  pinned: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkPinResponseSchema = Type.Object({
  ok: Type.Boolean(),
  pinned: Type.Boolean(),
  changedIds: Type.Array(identifierSchema),
  artifacts: Type.Array(Type.Object({
    artifactId: identifierSchema,
    pinned: Type.Boolean(),
    pinnedAt: Type.Optional(Type.String({ format: 'date-time' })),
  }, additionalProperties)),
}, additionalProperties);

export const dashboardArtifactArchiveBodySchema = Type.Object({ archived: Type.Boolean() }, additionalProperties);

export const dashboardArtifactArchiveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  artifactId: identifierSchema,
  archived: Type.Boolean(),
  archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
}, additionalProperties);

export const dashboardArtifactBulkArchiveBodySchema = Type.Object({
  ids: Type.Array(identifierSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  archived: Type.Boolean(),
}, additionalProperties);

export const dashboardArtifactBulkArchiveResponseSchema = Type.Object({
  ok: Type.Boolean(),
  archived: Type.Boolean(),
  changedIds: Type.Array(identifierSchema),
  artifacts: Type.Array(Type.Object({
    artifactId: identifierSchema,
    archived: Type.Boolean(),
    archivedAt: Type.Optional(Type.String({ format: 'date-time' })),
  }, additionalProperties)),
}, additionalProperties);

export type DashboardArtifactListRoute = {
  Querystring: Static<typeof dashboardArtifactListQuerySchema>;
  Reply: { 200: Static<typeof dashboardArtifactListResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactPinRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Body: Static<typeof dashboardArtifactPinBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactPinResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactBulkPinRoute = {
  Body: Static<typeof dashboardArtifactBulkPinBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkPinResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactArchiveRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Body: Static<typeof dashboardArtifactArchiveBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactArchiveResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactBulkArchiveRoute = {
  Body: Static<typeof dashboardArtifactBulkArchiveBodySchema>;
  Reply: { 200: Static<typeof dashboardArtifactBulkArchiveResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardArtifactFileRoute = {
  Params: Static<typeof dashboardArtifactParamsSchema>;
  Reply: { 200: unknown; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};
