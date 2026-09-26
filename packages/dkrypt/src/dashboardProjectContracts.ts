import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema } from '#apiCommonContracts.js';

export const dashboardProjectParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });

export const dashboardProjectResponseSchema = Type.Object({
  id: identifierSchema,
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 240 })),
  memberIds: Type.Optional(Type.Array(identifierSchema)),
  isDefault: Type.Boolean(),
  archivedAt: Type.Optional(Type.Number()),
  storageQuotaBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  dailyJobQuota: Type.Optional(Type.Integer({ minimum: 1 })),
  maxConcurrentJobs: Type.Optional(Type.Integer({ minimum: 1 })),
  createdBy: identifierSchema,
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
}, { additionalProperties: true });

export const dashboardProjectListResponseSchema = Type.Object({ projects: Type.Array(dashboardProjectResponseSchema) }, { additionalProperties: true });

export const dashboardProjectMembersResponseSchema = Type.Object({
  members: Type.Array(Type.Object({
    id: identifierSchema,
    username: identifierSchema,
    displayName: Type.String(),
    avatarUrl: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
}, { additionalProperties: true });

export const dashboardProjectCreateBodySchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Optional(Type.String({ maxLength: 240 })),
  memberIds: Type.Optional(Type.Array(identifierSchema, { maxItems: 500 })),
  storageQuotaBytes: Type.Optional(Type.Integer({ minimum: 1 })),
  dailyJobQuota: Type.Optional(Type.Integer({ minimum: 1 })),
  maxConcurrentJobs: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: true });

export const dashboardProjectPatchBodySchema = Type.Partial(Type.Object({
  name: Type.String({ minLength: 1, maxLength: 80 }),
  description: Type.Union([Type.String({ maxLength: 240 }), Type.Null()]),
  memberIds: Type.Array(identifierSchema, { maxItems: 500 }),
  storageQuotaBytes: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  dailyJobQuota: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  maxConcurrentJobs: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  archived: Type.Boolean(),
}, { additionalProperties: true }));

export type DashboardProjectListRoute = {
  Reply: { 200: Static<typeof dashboardProjectListResponseSchema> };
};

export type DashboardProjectMembersRoute = {
  Reply: { 200: Static<typeof dashboardProjectMembersResponseSchema>; 403: ApiErrorEnvelope };
};

export type DashboardProjectCreateRoute = {
  Body: Static<typeof dashboardProjectCreateBodySchema>;
  Reply: { 201: Static<typeof dashboardProjectResponseSchema>; 400: ApiErrorEnvelope; 403: ApiErrorEnvelope };
};

export type DashboardProjectUpdateRoute = {
  Params: Static<typeof dashboardProjectParamsSchema>;
  Body: Static<typeof dashboardProjectPatchBodySchema>;
  Reply: { 200: Static<typeof dashboardProjectResponseSchema>; 400: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope };
};
