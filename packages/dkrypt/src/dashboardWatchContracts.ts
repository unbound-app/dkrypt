import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { bundleIdSchema, identifierSchema, projectIdentifierSchema } from '#apiCommonContracts.js';
import { dashboardDispatchTargetSchema, dashboardMaintenanceWindowSchema, dashboardWatchResponseSchema } from '#dashboardModelsContracts.js';

const additionalProperties = { additionalProperties: true } as const;
const JsonObject = Type.Object({}, additionalProperties);

export const dashboardWatchInputSchema = Type.Object({
  projectId: Type.Optional(projectIdentifierSchema),
  bundleId: bundleIdSchema,
  repo: Type.Optional(Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' })),
  ghWorkflowFile: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  dispatchTargets: Type.Optional(Type.Array(dashboardDispatchTargetSchema, { maxItems: 10 })),
  pollCron: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  timezone: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  maintenanceWindow: Type.Optional(Type.Union([dashboardMaintenanceWindowSchema, Type.Null()])),
  missedRunPolicy: Type.Optional(Type.Union([Type.Literal('skip'), Type.Literal('runOnce')])),
  enabled: Type.Optional(Type.Boolean()),
  acknowledgeConflicts: Type.Optional(Type.Boolean()),
  webhookUrl: Type.Optional(Type.String({ maxLength: 500 })),
  testFlightPolicy: Type.Optional(Type.Union([Type.Literal('latest'), Type.Literal('latestNonExpired'), Type.Literal('train')])),
  testFlightTrain: Type.Optional(Type.String({ maxLength: 100 })),
}, additionalProperties);

export const dashboardWatchPatchSchema = Type.Intersect([
  Type.Partial(dashboardWatchInputSchema),
  Type.Object({ expectedUpdatedAt: Type.Optional(Type.Number({ minimum: 0 })) }, additionalProperties),
]);
export const dashboardWatchImportBodySchema = Type.Object({ watches: Type.Array(dashboardWatchInputSchema, { minItems: 1, maxItems: 100 }) }, additionalProperties);
export const dashboardWatchParamsSchema = Type.Object({ id: identifierSchema }, additionalProperties);
export const dashboardWatchCalendarQuerySchema = Type.Object({
  hours: Type.Optional(Type.Integer({ minimum: 1, maximum: 168 })),
  fromAt: Type.Optional(Type.Integer()),
  projectId: Type.Optional(projectIdentifierSchema),
}, additionalProperties);
export const dashboardGitHubBudgetHistoryQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  projectId: Type.Optional(projectIdentifierSchema),
}, additionalProperties);
export const dashboardGitHubWorkflowsQuerySchema = Type.Object({ repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }) }, additionalProperties);
export const dashboardWatchPreviewDraftBodySchema = Type.Object({
  bundleId: bundleIdSchema,
  repo: Type.String({ minLength: 3, maxLength: 200, pattern: '^[\\w.-]+/[\\w.-]+$' }),
}, additionalProperties);
export const dashboardWatchDispatchValidationBodySchema = Type.Object({ targets: Type.Array(dashboardDispatchTargetSchema, { minItems: 1, maxItems: 10 }) }, additionalProperties);
export const dashboardWatchSourceParamsSchema = Type.Object({
  id: identifierSchema,
  source: Type.Union([Type.Literal('app-store'), Type.Literal('testflight')]),
}, additionalProperties);

export const dashboardWatchListResponseSchema = Type.Object({ watches: Type.Array(dashboardWatchResponseSchema) }, additionalProperties);
export const dashboardWatchExportResponseSchema = Type.Object({ version: Type.Integer({ minimum: 1 }), watches: Type.Array(JsonObject) }, additionalProperties);
export const dashboardWatchHealthResponseSchema = Type.Object({ watches: Type.Array(JsonObject) }, additionalProperties);
export const dashboardWatchCalendarResponseSchema = Type.Object({
  fromAt: Type.Number(),
  untilAt: Type.Number(),
  runs: Type.Array(Type.Object({ watchId: identifierSchema, bundleId: bundleIdSchema, at: Type.Number(), deferred: Type.Boolean() }, additionalProperties)),
  truncated: Type.Boolean(),
}, additionalProperties);
export const dashboardGitHubBudgetHistoryResponseSchema = Type.Object({ entries: Type.Array(JsonObject) }, additionalProperties);
export const dashboardGitHubReposResponseSchema = Type.Object({ repos: Type.Array(JsonObject) }, additionalProperties);
export const dashboardGitHubWorkflowsResponseSchema = Type.Object({ workflows: Type.Array(JsonObject) }, additionalProperties);
export const dashboardWatchImportResponseSchema = Type.Object({ watches: Type.Array(dashboardWatchResponseSchema), skipped: Type.Array(Type.String()) }, additionalProperties);
export const dashboardWatchDispatchPreviewResponseSchema = Type.Object({
  ok: Type.Boolean(),
  itunesVersion: Type.Optional(Type.String()),
  normalizedVersion: Type.Optional(Type.String()),
  alreadyReleased: Type.Optional(Type.Boolean()),
  wouldDispatch: Type.Boolean(),
  reason: Type.String(),
  testflight: JsonObject,
}, additionalProperties);
export const dashboardWatchDispatchValidationResponseSchema = Type.Object({ results: Type.Array(JsonObject), ok: Type.Boolean() }, additionalProperties);
export const dashboardWatchSourcePreviewResponseSchema = Type.Object({ source: Type.Union([Type.Literal('appStore'), Type.Literal('testflight')]), result: JsonObject }, additionalProperties);
export const dashboardGitHubRateLimitResponseSchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  remaining: Type.Optional(Type.Integer({ minimum: 0 })),
  reset: Type.Optional(Type.Integer({ minimum: 0 })),
}, additionalProperties);

type CommonErrors = {
  400: ApiErrorEnvelope;
  401: ApiErrorEnvelope;
  403: ApiErrorEnvelope;
  404: ApiErrorEnvelope;
  409: ApiErrorEnvelope;
  429: ApiErrorEnvelope;
  500: ApiErrorEnvelope;
  503: ApiErrorEnvelope;
};

type GitHubErrors = CommonErrors & { 502: ApiErrorEnvelope };

export type DashboardGitHubRateLimitRoute = {
  Reply: { 200: Static<typeof dashboardGitHubRateLimitResponseSchema> } & GitHubErrors;
};
export type DashboardWatchListRoute = {
  Reply: { 200: Static<typeof dashboardWatchListResponseSchema> } & CommonErrors;
};
export type DashboardWatchExportRoute = {
  Reply: { 200: Static<typeof dashboardWatchExportResponseSchema> } & CommonErrors;
};
export type DashboardWatchHealthRoute = {
  Reply: { 200: Static<typeof dashboardWatchHealthResponseSchema> } & CommonErrors;
};
export type DashboardWatchCalendarRoute = {
  Querystring: Static<typeof dashboardWatchCalendarQuerySchema>;
  Reply: { 200: Static<typeof dashboardWatchCalendarResponseSchema> } & CommonErrors;
};
export type DashboardGitHubBudgetHistoryRoute = {
  Querystring: Static<typeof dashboardGitHubBudgetHistoryQuerySchema>;
  Reply: { 200: Static<typeof dashboardGitHubBudgetHistoryResponseSchema> } & CommonErrors;
};
export type DashboardGitHubReposRoute = {
  Reply: { 200: Static<typeof dashboardGitHubReposResponseSchema> } & GitHubErrors;
};
export type DashboardGitHubWorkflowsRoute = {
  Querystring: Static<typeof dashboardGitHubWorkflowsQuerySchema>;
  Reply: { 200: Static<typeof dashboardGitHubWorkflowsResponseSchema> } & GitHubErrors;
};
export type DashboardWatchCreateRoute = {
  Body: Static<typeof dashboardWatchInputSchema>;
  Reply: { 201: Static<typeof dashboardWatchResponseSchema> } & CommonErrors;
};
export type DashboardWatchUpdateRoute = {
  Params: Static<typeof dashboardWatchParamsSchema>;
  Body: Static<typeof dashboardWatchPatchSchema>;
  Reply: { 200: Static<typeof dashboardWatchResponseSchema> } & CommonErrors;
};
export type DashboardWatchDeleteRoute = {
  Params: Static<typeof dashboardWatchParamsSchema>;
  Reply: { 200: { ok: boolean } } & CommonErrors;
};
export type DashboardWatchImportRoute = {
  Body: Static<typeof dashboardWatchImportBodySchema>;
  Reply: { 201: Static<typeof dashboardWatchImportResponseSchema> } & CommonErrors;
};
export type DashboardWatchPreviewDraftRoute = {
  Body: Static<typeof dashboardWatchPreviewDraftBodySchema>;
  Reply: { 200: Static<typeof dashboardWatchDispatchPreviewResponseSchema> } & CommonErrors;
};
export type DashboardWatchDispatchValidationRoute = {
  Body: Static<typeof dashboardWatchDispatchValidationBodySchema>;
  Reply: { 200: Static<typeof dashboardWatchDispatchValidationResponseSchema> } & CommonErrors;
};
export type DashboardWatchPreviewRoute = {
  Params: Static<typeof dashboardWatchParamsSchema>;
  Reply: { 200: Static<typeof dashboardWatchDispatchPreviewResponseSchema> } & CommonErrors;
};
export type DashboardWatchSourcePreviewRoute = {
  Params: Static<typeof dashboardWatchSourceParamsSchema>;
  Reply: { 200: Static<typeof dashboardWatchSourcePreviewResponseSchema> } & CommonErrors;
};
export type DashboardWatchTriggerRoute = {
  Params: Static<typeof dashboardWatchParamsSchema>;
  Reply: { 202: { ok: boolean; error?: string }; 409: { ok: boolean; error?: string } } & CommonErrors;
};

export type WatchInput = Static<typeof dashboardWatchInputSchema>;
export type WatchPatchInput = Static<typeof dashboardWatchPatchSchema>;
export type WatchResponse = Static<typeof dashboardWatchResponseSchema>;
