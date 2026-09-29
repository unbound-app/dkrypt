import { Type, type Static } from '@sinclair/typebox';
import { identifierSchema, paginationQueryProperties } from '#apiCommonContracts.js';

export const notificationListQuerySchema = Type.Object({
  ...paginationQueryProperties,
}, { additionalProperties: true });

export const notificationPageResponseSchema = Type.Object({
  notifications: Type.Array(Type.Object({
    id: identifierSchema,
    userId: identifierSchema,
    title: Type.String(),
    message: Type.String(),
    severity: Type.Union([Type.Literal('info'), Type.Literal('success'), Type.Literal('warning'), Type.Literal('error')]),
    createdAt: Type.Number(),
    firstOccurredAt: Type.Optional(Type.Number()),
    lastOccurredAt: Type.Optional(Type.Number()),
    occurrenceCount: Type.Optional(Type.Integer({ minimum: 1 })),
    readAt: Type.Optional(Type.Number()),
    jobId: Type.Optional(Type.String()),
    deviceId: Type.Optional(Type.String()),
    href: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
  unread: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const notificationReadBodySchema = Type.Object({
  ids: Type.Optional(Type.Array(identifierSchema, { maxItems: 100 })),
}, { additionalProperties: true });

export const notificationReadResponseSchema = Type.Object({ ok: Type.Boolean(), marked: Type.Integer({ minimum: 0 }) });

export type DashboardNotificationsListRoute = {
  Querystring: Static<typeof notificationListQuerySchema>;
  Reply: { 200: Static<typeof notificationPageResponseSchema> };
};

export type DashboardNotificationReadRoute = {
  Body: Static<typeof notificationReadBodySchema>;
  Reply: { 200: Static<typeof notificationReadResponseSchema> };
};
