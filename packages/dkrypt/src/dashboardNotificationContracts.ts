import { Type, type Static } from '@sinclair/typebox';

export const notificationListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: true });

export const notificationPageResponseSchema = Type.Object({
  notifications: Type.Array(Type.Object({
    id: Type.String({ minLength: 1, maxLength: 200 }),
    userId: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String(),
    message: Type.String(),
    severity: Type.Union([Type.Literal('info'), Type.Literal('success'), Type.Literal('warning'), Type.Literal('error')]),
    createdAt: Type.Number(),
    readAt: Type.Optional(Type.Number()),
    jobId: Type.Optional(Type.String()),
    href: Type.Optional(Type.String()),
  }, { additionalProperties: true })),
  unread: Type.Integer({ minimum: 0 }),
  total: Type.Integer({ minimum: 0 }),
  nextCursor: Type.Optional(Type.String()),
}, { additionalProperties: true });

export const notificationReadBodySchema = Type.Object({
  ids: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 100 })),
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
