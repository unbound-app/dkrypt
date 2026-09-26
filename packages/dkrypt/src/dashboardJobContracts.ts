import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope, DashboardJobHistoryPage, DashboardJobSummary, DashboardJobTimeline } from '#contracts.js';
import { bundleIdSchema as BundleId, deviceTransportSchema, identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';

const JobStatus = Type.Union([Type.Literal('queued'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]);
const JsonObject = Type.Object({}, { additionalProperties: true });
export const dashboardJobTimelineEventSchema = Type.Object({ at: Type.Number(), label: Type.String(), status: JobStatus }, { additionalProperties: true });
const TestFlightBuild = Type.Object({
  id: Type.Number(),
  cfBundleShortVersion: Type.String(),
  cfBundleVersion: Type.String(),
  bundleId: BundleId,
}, { additionalProperties: true });
const IpaMetadata = Type.Object({
  bundleVersion: Type.Optional(Type.String()),
  shortVersion: Type.Optional(Type.String()),
  minOsVersion: Type.Optional(Type.String()),
  executable: Type.Optional(Type.String()),
  architectures: Type.Optional(Type.Array(Type.String())),
  entitlementKeys: Type.Optional(Type.Array(Type.String())),
  embeddedFrameworks: Type.Optional(Type.Array(Type.String())),
  fileCount: Type.Optional(Type.Number()),
  compressedSizeBytes: Type.Optional(Type.Number()),
  uncompressedSizeBytes: Type.Optional(Type.Number()),
  codeSignaturePresent: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });
const Requester = Type.Object({
  username: Type.Optional(Type.String()),
  displayName: Type.String(),
  avatarUrl: Type.Optional(Type.String()),
}, { additionalProperties: true });
const DashboardJobHistoryEntry = Type.Object({
  id: identifierSchema,
  correlationId: Type.Optional(identifierSchema),
  projectId: Type.Optional(identifierSchema),
  bundleId: BundleId,
  externalVersionId: Type.Optional(identifierSchema),
  testflight: Type.Optional(Type.Object({ appId: Type.Number(), build: TestFlightBuild }, { additionalProperties: true })),
  versionLabel: Type.Optional(Type.String()),
  queuedBy: Type.Optional(Type.String()),
  requester: Type.Optional(Requester),
  status: Type.Union([Type.Literal('done'), Type.Literal('failed')]),
  warnings: Type.Optional(Type.Array(Type.String())),
  error: Type.Optional(Type.String()),
  artifactId: Type.Optional(identifierSchema),
  sizeBytes: Type.Optional(Type.Number()),
  sha256: Type.Optional(Type.String()),
  source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
  createdAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  finishedAt: Type.Number(),
  deviceId: Type.Optional(identifierSchema),
  transport: Type.Optional(deviceTransportSchema),
  ipaMetadata: Type.Optional(IpaMetadata),
  ipaInfoPlist: Type.Optional(JsonObject),
  timeline: Type.Optional(Type.Array(dashboardJobTimelineEventSchema)),
  attempt: Type.Optional(Type.Number()),
  retryCount: Type.Optional(Type.Number()),
  deadlineAt: Type.Optional(Type.Number()),
  deadlineExceeded: Type.Optional(Type.Boolean()),
  failureClass: Type.Optional(Type.String()),
  downloadUrl: Type.Optional(Type.String()),
  fileAvailable: Type.Boolean(),
}, { additionalProperties: true });

export const dashboardJobListQuerySchema = Type.Object({
  ...paginationQueryProperties,
  projectId: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9_-]{1,80}$' })),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  source: Type.Optional(Type.Union([Type.Literal('manual'), Type.Literal('scheduler')])),
  status: Type.Optional(Type.Union([Type.Literal('done'), Type.Literal('failed')])),
  queuedBy: Type.Optional(Type.String({ maxLength: 120 })),
  deviceId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  errorQ: Type.Optional(Type.String({ maxLength: 200 })),
  failureCategory: Type.Optional(Type.String({ maxLength: 64 })),
  fromTs: Type.Optional(Type.Integer()),
  toTs: Type.Optional(Type.Integer()),
}, { additionalProperties: true });

export const dashboardJobParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });

export const dashboardJobHistoryPageSchema = Type.Object({
  history: Type.Array(DashboardJobHistoryEntry),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export type DashboardJobListRoute = {
  Querystring: Static<typeof dashboardJobListQuerySchema>;
  Reply: { 200: DashboardJobHistoryPage; 404: ApiErrorEnvelope };
};

export type DashboardJobStatusRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: DashboardJobSummary; 404: ApiErrorEnvelope };
};

export type DashboardJobTimelineRoute = {
  Params: Static<typeof dashboardJobParamsSchema>;
  Reply: { 200: DashboardJobTimeline; 404: ApiErrorEnvelope };
};
