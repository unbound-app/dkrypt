import { Type, type Static } from '@sinclair/typebox';
import type { ApiErrorEnvelope } from '#contracts.js';
import { identifierSchema } from '#apiCommonContracts.js';

export const dashboardDiscordGuildSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  icon: Type.Union([Type.Null(), Type.String()]),
}, { additionalProperties: true });

export const dashboardDiscordRoleSchema = Type.Object({
  id: identifierSchema,
  name: Type.String(),
  color: Type.Integer(),
  position: Type.Integer(),
}, { additionalProperties: true });

export const dashboardDiscordPerkSchema = Type.Object({
  id: identifierSchema,
  guildId: identifierSchema,
  guildName: Type.Optional(Type.String()),
  guildIcon: Type.Union([Type.Null(), Type.String()]),
  discordRoleId: identifierSchema,
  discordRoleName: Type.Optional(Type.String()),
  discordRoleColor: Type.Integer(),
  appRoleId: identifierSchema,
  createdAt: Type.Number(),
}, { additionalProperties: true });

export const dashboardDiscordStatusResponseSchema = Type.Object({
  botEnabled: Type.Boolean(),
  guilds: Type.Array(dashboardDiscordGuildSchema),
}, { additionalProperties: true });

export const dashboardDiscordGuildsResponseSchema = Type.Object({
  guilds: Type.Array(dashboardDiscordGuildSchema),
}, { additionalProperties: true });

export const dashboardDiscordGuildsUpdateBodySchema = Type.Object({
  guilds: Type.Array(dashboardDiscordGuildSchema),
}, { additionalProperties: true });

export const dashboardDiscordGuildsUpdateResponseSchema = Type.Object({
  ok: Type.Boolean(),
  guilds: Type.Array(dashboardDiscordGuildSchema),
}, { additionalProperties: true });

export const dashboardDiscordRolesQuerySchema = Type.Object({
  guildId: identifierSchema,
}, { additionalProperties: true });

export const dashboardDiscordRolesResponseSchema = Type.Object({
  roles: Type.Array(dashboardDiscordRoleSchema),
}, { additionalProperties: true });

export const dashboardDiscordPerksResponseSchema = Type.Object({
  perks: Type.Array(dashboardDiscordPerkSchema),
}, { additionalProperties: true });

export const dashboardDiscordPerkCreateBodySchema = Type.Object({
  guildId: identifierSchema,
  guildName: Type.String({ minLength: 1, maxLength: 200 }),
  guildIcon: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  discordRoleId: identifierSchema,
  discordRoleName: Type.String({ minLength: 1, maxLength: 200 }),
  discordRoleColor: Type.Integer({ minimum: 0 }),
  appRoleId: identifierSchema,
}, { additionalProperties: true });

export const dashboardDiscordPerkParamsSchema = Type.Object({ id: identifierSchema }, { additionalProperties: true });
export const dashboardDiscordOkResponseSchema = Type.Object({ ok: Type.Boolean() }, { additionalProperties: true });

export type DashboardDiscordStatusRoute = {
  Reply: { 200: Static<typeof dashboardDiscordStatusResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordGuildsRoute = {
  Reply: { 200: Static<typeof dashboardDiscordGuildsResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordGuildsUpdateRoute = {
  Body: Static<typeof dashboardDiscordGuildsUpdateBodySchema>;
  Reply: { 200: Static<typeof dashboardDiscordGuildsUpdateResponseSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordRolesRoute = {
  Querystring: Static<typeof dashboardDiscordRolesQuerySchema>;
  Reply: { 200: Static<typeof dashboardDiscordRolesResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordPerksRoute = {
  Reply: { 200: Static<typeof dashboardDiscordPerksResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordPerkCreateRoute = {
  Body: Static<typeof dashboardDiscordPerkCreateBodySchema>;
  Reply: { 201: Static<typeof dashboardDiscordPerkSchema>; 400: ApiErrorEnvelope; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};

export type DashboardDiscordPerkDeleteRoute = {
  Params: Static<typeof dashboardDiscordPerkParamsSchema>;
  Reply: { 200: Static<typeof dashboardDiscordOkResponseSchema>; 401: ApiErrorEnvelope; 403: ApiErrorEnvelope; 404: ApiErrorEnvelope; 429: ApiErrorEnvelope; 500: ApiErrorEnvelope };
};
