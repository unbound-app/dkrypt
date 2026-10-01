import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { Response } from '#http.js';
import { PermissionFlag } from '#permissions.js';
import { dashboardRouter } from '#routes/dashboard.js';
import { createDashboardDiscordRoutes, type DashboardDiscordServices } from '#routes/dashboardDiscordRoutes.js';
import { buildTestServer } from '#testServer.js';
import { setSessionCookie } from '#session.js';
import type { DiscordGuildConfiguration, DiscordRolePerk, Role } from '#store/state.js';

function sessionCookie(permissions: bigint): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions });
  return value.split(';', 1)[0]!;
}

const configuredGuild: DiscordGuildConfiguration = { id: 'guild-1', name: 'Server One', icon: null };

function createRole(overrides: Partial<Role> = {}): Role {
  return {
    id: 'dashboard-role',
    name: 'Decryptors',
    color: '#123456',
    permissions: '8',
    position: 1,
    isDefault: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createPerk(overrides: Partial<DiscordRolePerk> = {}): DiscordRolePerk {
  return {
    id: 'perk-1',
    guildId: configuredGuild.id,
    guildName: configuredGuild.name,
    guildIcon: null,
    discordRoleId: 'discord-role-1',
    discordRoleName: 'Tester',
    discordRoleColor: 1193046,
    appRoleId: 'dashboard-role',
    createdAt: 1,
    ...overrides,
  };
}

function build(overrides: Partial<DashboardDiscordServices> = {}) {
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  void server.register(createDashboardDiscordRoutes({
    discordBotEnabled: true,
    getDiscordGuilds: () => [configuredGuild],
    listRoles: () => [createRole()],
    canGrantBits: () => true,
    ...overrides,
  }));
  return server;
}

test('Discord routes are not registered through the legacy dashboard router', () => {
  const routes = dashboardRouter.routes.map((route) => `${route.method} ${route.path}`);
  expect(routes).not.toContain('GET /v1/dashboard/discord/status');
  expect(routes).not.toContain('GET /v1/dashboard/discord/guilds');
  expect(routes).not.toContain('POST /v1/dashboard/discord/guilds');
  expect(routes).not.toContain('GET /v1/dashboard/discord/roles');
  expect(routes).not.toContain('GET /v1/dashboard/discord/perks');
  expect(routes).not.toContain('POST /v1/dashboard/discord/perks');
  expect(routes).not.toContain('DELETE /v1/dashboard/discord/perks/:id');
});

test('the API server mounts Discord routes through Fastify', async () => {
  const server = await buildTestServer({ includePublicRoutes: false });

  try {
    const response = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/discord/status',
      headers: { cookie: sessionCookie(PermissionFlag.viewRoles) },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ botEnabled: expect.any(Boolean), guilds: expect.any(Array) });
  } finally {
    await server.close();
  }
});

test('Discord read routes preserve permissions and only fetch roles for selected guilds', async () => {
  const fetchedGuildRoles: string[] = [];
  const server = build({
    fetchBotGuilds: async () => [configuredGuild, { id: 'guild-2', name: 'Server Two', icon: null }],
    fetchGuildRoles: async (guildId) => {
      fetchedGuildRoles.push(guildId);
      return [{ id: 'discord-role-1', name: 'Tester', color: 1193046, position: 4 }];
    },
    getDiscordRolePerks: () => [createPerk()],
  });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.viewRoles) };
    const status = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/status', headers });
    const guilds = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/guilds', headers });
    const roles = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/roles?guildId=guild-1', headers });
    const unselectedRoles = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/roles?guildId=guild-2', headers });
    const perks = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/perks', headers });
    const denied = await server.inject({ method: 'GET', url: '/v1/dashboard/discord/status', headers: { cookie: sessionCookie(0n) } });

    expect(status.statusCode).toBe(200);
    expect(JSON.parse(status.body)).toEqual({ botEnabled: true, guilds: [configuredGuild] });
    expect(JSON.parse(guilds.body)).toEqual({ guilds: [configuredGuild, { id: 'guild-2', name: 'Server Two', icon: null }] });
    expect(JSON.parse(roles.body)).toEqual({ roles: [{ id: 'discord-role-1', name: 'Tester', color: 1193046, position: 4 }] });
    expect(JSON.parse(unselectedRoles.body)).toEqual({ roles: [] });
    expect(JSON.parse(perks.body)).toEqual({ perks: [createPerk()] });
    expect(fetchedGuildRoles).toEqual(['guild-1']);
    expect(denied.statusCode).toBe(403);
  } finally {
    await server.close();
  }
});

test('Discord guild updates and perk changes require manager access and safe role mappings', async () => {
  let selectedGuilds: DiscordGuildConfiguration[] = [configuredGuild];
  const setGuildsActors: string[] = [];
  const createdPerks: unknown[][] = [];
  const removedPerks: string[] = [];
  const server = build({
    getDiscordGuilds: () => selectedGuilds,
    setDiscordGuilds: (guilds, actor) => {
      selectedGuilds = guilds;
      setGuildsActors.push(actor);
    },
    effectiveBitsForRoleIds: (ids) => ids.length === 1 ? 8n : 0n,
    createDiscordRolePerk: (guild, discordRole, roleId, actor) => {
      createdPerks.push([guild, discordRole, roleId, actor]);
      return createPerk({ guildId: guild.id, guildName: guild.name, guildIcon: guild.icon, discordRoleId: discordRole.id, discordRoleName: discordRole.name, discordRoleColor: discordRole.color, appRoleId: roleId });
    },
    deleteDiscordRolePerk: (id, actor) => {
      removedPerks.push(`${id}:${actor}`);
      return id === 'perk-1';
    },
  });

  try {
    const managerHeaders = { cookie: sessionCookie(PermissionFlag.manageRoles) };
    const denied = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/discord/guilds',
      headers: { cookie: sessionCookie(PermissionFlag.viewRoles) },
      payload: { guilds: [configuredGuild] },
    });
    const guildUpdate = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/discord/guilds',
      headers: managerHeaders,
      payload: { guilds: [{ id: ' guild-1 ', name: ' Server One ', icon: null }, { id: ' ', name: ' ', icon: null }] },
    });
    const created = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/discord/perks',
      headers: managerHeaders,
      payload: { guildId: 'guild-1', guildName: ' Server One ', discordRoleId: ' discord-role-1 ', discordRoleName: ' Tester ', discordRoleColor: 1193046, appRoleId: ' dashboard-role ' },
    });
    const removed = await server.inject({ method: 'DELETE', url: '/v1/dashboard/discord/perks/perk-1', headers: managerHeaders });
    const missing = await server.inject({ method: 'DELETE', url: '/v1/dashboard/discord/perks/missing', headers: managerHeaders });

    expect(denied.statusCode).toBe(403);
    expect(guildUpdate.statusCode).toBe(200);
    expect(JSON.parse(guildUpdate.body)).toEqual({ ok: true, guilds: [configuredGuild] });
    expect(setGuildsActors).toEqual(['root']);
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ guildId: 'guild-1', guildName: 'Server One', discordRoleId: 'discord-role-1', discordRoleName: 'Tester', appRoleId: 'dashboard-role' });
    expect(createdPerks).toEqual([[configuredGuild, { id: 'discord-role-1', name: 'Tester', color: 1193046 }, 'dashboard-role', 'root']]);
    expect(removed.statusCode).toBe(200);
    expect(JSON.parse(removed.body)).toEqual({ ok: true });
    expect(missing.statusCode).toBe(404);
    expect(removedPerks).toEqual(['perk-1:root', 'missing:root']);
  } finally {
    await server.close();
  }
});

test('Discord perk mapping rejects unselected guilds, the default role, and excessive permission grants', async () => {
  const server = build({ canGrantBits: (_actorBits, targetBits) => targetBits === 0n });

  try {
    const headers = { cookie: sessionCookie(PermissionFlag.manageRoles) };
    const basePayload = { guildId: 'guild-1', guildName: 'Server One', discordRoleId: 'discord-role-1', discordRoleName: 'Tester', discordRoleColor: 1, appRoleId: 'dashboard-role' };
    const unselected = await server.inject({ method: 'POST', url: '/v1/dashboard/discord/perks', headers, payload: { ...basePayload, guildId: 'other' } });
    const defaultRole = await server.inject({ method: 'POST', url: '/v1/dashboard/discord/perks', headers, payload: { ...basePayload, appRoleId: 'everyone' } });
    const excessive = await server.inject({ method: 'POST', url: '/v1/dashboard/discord/perks', headers, payload: basePayload });

    expect(unselected.statusCode).toBe(400);
    expect(unselected.json()).toMatchObject({ error: 'guild is not selected for Discord role perks' });
    expect(defaultRole.statusCode).toBe(400);
    expect(defaultRole.json()).toMatchObject({ error: 'appRoleId must reference a non-default dashboard role' });
    expect(excessive.statusCode).toBe(403);
    expect(excessive.json()).toMatchObject({ error: "you can't map a Discord role to permissions you don't have yourself" });
  } finally {
    await server.close();
  }
});
