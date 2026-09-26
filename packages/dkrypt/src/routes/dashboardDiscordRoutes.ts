import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type {
  DashboardDiscordGuildsRoute,
  DashboardDiscordGuildsUpdateRoute,
  DashboardDiscordPerkCreateRoute,
  DashboardDiscordPerkDeleteRoute,
  DashboardDiscordPerksRoute,
  DashboardDiscordRolesRoute,
  DashboardDiscordStatusRoute,
} from '#dashboardDiscordContracts.js';
import { canGrantBits } from '#dashboardAdminRules.js';
import { recordFastifyDashboardActivity } from '#dashboardActivity.js';
import { discordBotEnabled } from '#config.js';
import { getRouteContract } from '#contracts.js';
import { fetchBotGuilds, fetchGuildRoles } from '#discord.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import {
  createDiscordRolePerk,
  deleteDiscordRolePerk,
  effectiveBitsForRoleIds,
  getDiscordGuilds,
  getDiscordRolePerks,
  listRoles,
  setDiscordGuilds,
} from '#store/state.js';
import { createHttpErrorEnvelope } from '#util/httpResponse.js';

export interface DashboardDiscordServices {
  canGrantBits: typeof canGrantBits;
  createDiscordRolePerk: typeof createDiscordRolePerk;
  deleteDiscordRolePerk: typeof deleteDiscordRolePerk;
  discordBotEnabled: boolean;
  effectiveBitsForRoleIds: typeof effectiveBitsForRoleIds;
  fetchBotGuilds: typeof fetchBotGuilds;
  fetchGuildRoles: typeof fetchGuildRoles;
  getDiscordGuilds: typeof getDiscordGuilds;
  getDiscordRolePerks: typeof getDiscordRolePerks;
  listRoles: typeof listRoles;
  setDiscordGuilds: typeof setDiscordGuilds;
}

const defaultServices: DashboardDiscordServices = {
  canGrantBits,
  createDiscordRolePerk,
  deleteDiscordRolePerk,
  discordBotEnabled,
  effectiveBitsForRoleIds,
  fetchBotGuilds,
  fetchGuildRoles,
  getDiscordGuilds,
  getDiscordRolePerks,
  listRoles,
  setDiscordGuilds,
};

const canViewDiscordPerks = fastifyRequirePermission(PermissionFlag.viewRoles, PermissionFlag.manageRoles);
const canManageDiscordPerks = fastifyRequirePermission(PermissionFlag.manageRoles);

function sendDiscordError(requestId: string, reply: { code(statusCode: number): unknown }, statusCode: 400 | 403 | 404, message: string) {
  reply.code(statusCode);
  return createHttpErrorEnvelope(requestId, statusCode, message);
}

export function createDashboardDiscordRoutes(overrides: Partial<DashboardDiscordServices> = {}): FastifyPluginAsyncTypebox {
  const services = { ...defaultServices, ...overrides };

  return async (server) => {
    server.addHook('preHandler', fastifyRequireSession);
    server.addHook('preHandler', recordFastifyDashboardActivity);

    server.get<DashboardDiscordStatusRoute>('/v1/dashboard/discord/status', {
      schema: getRouteContract('GET', '/v1/dashboard/discord/status'),
      preHandler: canViewDiscordPerks,
    }, () => ({ botEnabled: services.discordBotEnabled, guilds: services.getDiscordGuilds() }));

    server.get<DashboardDiscordGuildsRoute>('/v1/dashboard/discord/guilds', {
      schema: getRouteContract('GET', '/v1/dashboard/discord/guilds'),
      preHandler: canViewDiscordPerks,
    }, async () => ({ guilds: await services.fetchBotGuilds() }));

    server.post<DashboardDiscordGuildsUpdateRoute>('/v1/dashboard/discord/guilds', {
      schema: getRouteContract('POST', '/v1/dashboard/discord/guilds'),
      preHandler: canManageDiscordPerks,
    }, (request) => {
      const guilds = request.body.guilds
        .map((guild) => ({ id: guild.id.trim(), name: guild.name.trim(), icon: guild.icon }))
        .filter((guild) => guild.id && guild.name);
      services.setDiscordGuilds(guilds, getFastifySession(request)!.sub);
      return { ok: true, guilds: services.getDiscordGuilds() };
    });

    server.get<DashboardDiscordRolesRoute>('/v1/dashboard/discord/roles', {
      schema: getRouteContract('GET', '/v1/dashboard/discord/roles'),
      preHandler: canViewDiscordPerks,
    }, async (request) => {
      const guildId = request.query.guildId;
      if (!services.getDiscordGuilds().some((guild) => guild.id === guildId)) return { roles: [] };
      return { roles: await services.fetchGuildRoles(guildId) };
    });

    server.get<DashboardDiscordPerksRoute>('/v1/dashboard/discord/perks', {
      schema: getRouteContract('GET', '/v1/dashboard/discord/perks'),
      preHandler: canViewDiscordPerks,
    }, () => ({ perks: services.getDiscordRolePerks() }));

    server.post<DashboardDiscordPerkCreateRoute>('/v1/dashboard/discord/perks', {
      schema: getRouteContract('POST', '/v1/dashboard/discord/perks'),
      preHandler: canManageDiscordPerks,
    }, (request, reply) => {
      const guildId = request.body.guildId.trim();
      const guildName = request.body.guildName.trim();
      const discordRoleId = request.body.discordRoleId.trim();
      const discordRoleName = request.body.discordRoleName.trim();
      const appRoleId = request.body.appRoleId.trim();
      const discordRoleColor = request.body.discordRoleColor;
      if (!guildId || !guildName || !discordRoleId || !discordRoleName || !appRoleId) {
        return sendDiscordError(request.id, reply, 400, 'guild and Discord role details plus appRoleId are required');
      }
      const guild = services.getDiscordGuilds().find((entry) => entry.id === guildId);
      if (!guild) return sendDiscordError(request.id, reply, 400, 'guild is not selected for Discord role perks');
      const roles = services.listRoles();
      const targetRole = roles.find((role) => role.id === appRoleId && !role.isDefault);
      if (!targetRole) return sendDiscordError(request.id, reply, 400, 'appRoleId must reference a non-default dashboard role');
      const session = getFastifySession(request)!;
      if (!services.canGrantBits(session.permissions, services.effectiveBitsForRoleIds([appRoleId], roles))) {
        return sendDiscordError(request.id, reply, 403, "you can't map a Discord role to permissions you don't have yourself");
      }
      reply.code(201);
      return services.createDiscordRolePerk(
        { id: guildId, name: guildName, icon: request.body.guildIcon ?? null },
        { id: discordRoleId, name: discordRoleName, color: discordRoleColor },
        appRoleId,
        session.sub,
      );
    });

    server.delete<DashboardDiscordPerkDeleteRoute>('/v1/dashboard/discord/perks/:id', {
      schema: getRouteContract('DELETE', '/v1/dashboard/discord/perks/:id'),
      preHandler: canManageDiscordPerks,
    }, (request, reply) => {
      if (!services.deleteDiscordRolePerk(request.params.id, getFastifySession(request)!.sub)) {
        return sendDiscordError(request.id, reply, 404, 'perk not found');
      }
      return { ok: true };
    });
  };
}

export const dashboardDiscordRoutes = createDashboardDiscordRoutes();
