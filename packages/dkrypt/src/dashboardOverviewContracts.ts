import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema, projectIdentifierSchema } from '#apiCommonContracts.js';

const Identifier = identifierSchema;
const BundleId = Type.String({ minLength: 3, maxLength: 200, pattern: '^[A-Za-z0-9.-]+$' });
const JsonObject = Type.Object({}, { additionalProperties: true });
const JobFailureClass = Type.Union([
  Type.Literal('device_transport'),
  Type.Literal('app_store'),
  Type.Literal('testflight'),
  Type.Literal('network'),
  Type.Literal('storage'),
  Type.Literal('decrypt'),
  Type.Literal('cancelled'),
  Type.Literal('unknown'),
]);

export const dashboardOverviewQuerySchema = Type.Object({ projectId: Type.Optional(projectIdentifierSchema) }, { additionalProperties: true });

export const dashboardOverviewResponseSchema = Type.Object({
  projectId: Identifier,
  schedulerEnabled: Type.Boolean(),
  settings: JsonObject,
  watches: Type.Array(JsonObject),
  devices: Type.Array(JsonObject),
  lastSchedulerRunAt: Type.Optional(Type.Number()),
  schedulerRunHistory: Type.Array(JsonObject),
  disk: Type.Optional(JsonObject),
  isPaidPlan: Type.Boolean(),
  maintenance: JsonObject,
  activeJobs: Type.Array(Type.Object({
    id: Identifier,
    correlationId: Identifier,
    bundleId: BundleId,
    source: Type.Union([Type.Literal('manual'), Type.Literal('scheduler')]),
    status: Type.Union([Type.Literal('queued'), Type.Literal('running')]),
    progress: Type.String(),
    versionLabel: Type.Optional(Type.String()),
    deviceId: Type.Optional(Identifier),
    transport: Type.Optional(Type.Union([Type.Literal('wifi'), Type.Literal('usb')])),
    testflight: Type.Optional(Type.Object({
      appId: Type.Number(),
      buildId: Type.Number(),
      version: Type.Optional(Type.String()),
      buildNumber: Type.Optional(Type.String()),
    }, { additionalProperties: true })),
    queuedBy: Type.Optional(Type.String()),
    priority: Type.Number(),
    createdAt: Type.Number(),
    attempt: Type.Optional(Type.Number()),
    retryCount: Type.Optional(Type.Number()),
    deadlineAt: Type.Optional(Type.Number()),
    deadlineExceeded: Type.Optional(Type.Boolean()),
    failureClass: Type.Optional(JobFailureClass),
    warnings: Type.Optional(Type.Array(Type.String())),
    queueReason: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

export type DashboardOverviewRoute = {
  Querystring: Static<typeof dashboardOverviewQuerySchema>;
  Reply: {
    200: Static<typeof dashboardOverviewResponseSchema>;
    400: ApiErrorEnvelope;
    401: ApiErrorEnvelope;
    404: ApiErrorEnvelope;
  };
};
