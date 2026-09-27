import { Type, type Static } from '@sinclair/typebox';

const userPrefsProperties = {
  theme: Type.Optional(Type.Union([Type.Literal('dark'), Type.Literal('light'), Type.Literal('auto')])),
  density: Type.Optional(Type.Union([Type.Literal('comfortable'), Type.Literal('compact')])),
  accent: Type.Optional(Type.String()),
  highContrast: Type.Optional(Type.Boolean()),
  sound: Type.Optional(Type.Boolean()),
  pushOnSuccess: Type.Optional(Type.Boolean()),
  pushOnFailure: Type.Optional(Type.Boolean()),
  pushOnAlerts: Type.Optional(Type.Boolean()),
  pushOnKeyExpiry: Type.Optional(Type.Boolean()),
  emailOnSuccess: Type.Optional(Type.Boolean()),
  emailOnFailure: Type.Optional(Type.Boolean()),
  emailOnAlerts: Type.Optional(Type.Boolean()),
  emailOnKeyExpiry: Type.Optional(Type.Boolean()),
  notifyEmail: Type.Optional(Type.String()),
  preferPrimaryDevice: Type.Optional(Type.Boolean()),
};

export const userPrefsResponseSchema = Type.Object({ ...userPrefsProperties, accountEmail: Type.Optional(Type.String()) }, { additionalProperties: true });
export const userPrefsPatchBodySchema = Type.Object(userPrefsProperties, { additionalProperties: true });

export const pushSubscriptionBodySchema = Type.Object({
  endpoint: Type.String({ minLength: 1, maxLength: 2000 }),
  keys: Type.Object({ p256dh: Type.String({ minLength: 1 }), auth: Type.String({ minLength: 1 }) }, { additionalProperties: true }),
}, { additionalProperties: true });

export const pushUnsubscribeBodySchema = Type.Object({ endpoint: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: true });
export const pushKeyResponseSchema = Type.Object({ publicKey: Type.String() });
export const dashboardOkResponseSchema = Type.Object({ ok: Type.Boolean() });

type DashboardOkReply = { 200: Static<typeof dashboardOkResponseSchema> };

export type DashboardPrefsGetRoute = { Reply: { 200: Static<typeof userPrefsResponseSchema> } };
export type DashboardPrefsUpdateRoute = { Body: Static<typeof userPrefsPatchBodySchema>; Reply: { 200: Static<typeof userPrefsResponseSchema> } };
export type DashboardPushPublicKeyRoute = { Reply: { 200: Static<typeof pushKeyResponseSchema> } };
export type DashboardPushSubscribeRoute = { Body: Static<typeof pushSubscriptionBodySchema>; Reply: DashboardOkReply };
export type DashboardPushUnsubscribeRoute = { Body: Static<typeof pushUnsubscribeBodySchema>; Reply: DashboardOkReply };
export type DashboardPushTestRoute = { Reply: DashboardOkReply };
export type DashboardEmailTestRoute = { Reply: DashboardOkReply & { 400: { error: string; code: string; message: string; requestId: string; retryable: boolean } } };
