import { Router, type Request, type Response } from '#http.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { discordBotEnabled } from '#config.js';
import { fetchBotGuilds, fetchGuildRoles } from '#discord.js';
import { dashboardEvents, getOnlineUsernames, nextDashboardSequence, registerDashboardConnection, registerPresence, unregisterPresence } from '#events.js';
import type { LogEntry } from '#logger.js';
import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';
import { canGrantBits } from '#dashboardAdminRules.js';
import { requirePermission, requireSession } from '#session.js';
import { recordDashboardSessionActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import {
  createDiscordRolePerk,
  DEFAULT_PROJECT_ID,
  deleteDiscordRolePerk,
  effectiveBitsForRoleIds,
  getDiscordGuilds,
  getDiscordRolePerks,
  getProject,
  getUserEffectivePermissions,
  type JobHistoryEntry,
  listRoles,
  setDiscordGuilds,
} from '#store/state.js';

const canViewDiscordPerks = requirePermission(PermissionFlag.viewRoles, PermissionFlag.manageRoles);
const canManageDiscordPerks = requirePermission(PermissionFlag.manageRoles);
export const dashboardRouter = Router();

dashboardRouter.use(requireSession);
dashboardRouter.use((_req, res, next) => {
  recordDashboardSessionActivity(res.locals.session);
  next();
});

dashboardRouter.get('/v1/dashboard/events', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.raw.setTimeout(0);

  const { sub } = res.locals.session;
  let projectAccessRevoked = false;
  const closeForRevokedProject = (): boolean => {
    if (projectAccessRevoked) return false;
    const currentPermissions = sub === 'root' ? res.locals.session.permissions : getUserEffectivePermissions(sub);
    const permissionsRemainValid = isSubsetPermission(res.locals.session.permissions, currentPermissions);
    if (permissionsRemainValid && canAccessProject(sub, currentPermissions, projectId)) return true;
    projectAccessRevoked = true;
    const sequence = nextDashboardSequence();
    res.write(`id: ${sequence}\nevent: project-access-revoked\ndata: ${JSON.stringify({ sequence, data: { projectId } })}\n\n`);
    res.raw.end();
    return false;
  };
  const sendEvent = (event: string, data: unknown) => {
    if (!closeForRevokedProject()) return;
    const sequence = nextDashboardSequence();
    const payload = Array.isArray(data) ? { sequence, data } : data && typeof data === 'object' ? { ...(data as Record<string, unknown>), sequence } : { sequence, data };
    res.write(`id: ${sequence}\nevent: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  sendEvent('overview', buildDashboardOverview(res.locals.session.permissions, res.locals.session.sub, projectId));

  registerPresence(sub);
  const unregisterDashboardConnection = registerDashboardConnection(() => {
    if (!res.raw.destroyed && !res.raw.writableEnded) res.raw.end();
  });
  sendEvent('presence', getOnlineUsernames());

  const onJobsChanged = () => sendEvent('overview', buildDashboardOverview(res.locals.session.permissions, res.locals.session.sub, projectId));
  const onLogAdded = (entry: LogEntry) => {
    if (logBelongsToProject(entry, projectId)) sendEvent('log', entry);
  };
  const onHistoryAdded = (entry: JobHistoryEntry) => {
    if ((entry.projectId ?? DEFAULT_PROJECT_ID) === projectId) sendEvent('history', dashboardHistoryEntry(entry));
  };
  const onPresenceChanged = (usernames: string[]) => sendEvent('presence', usernames);
  const onProjectChanged = (changedProjectId?: string) => {
    if (changedProjectId === undefined || changedProjectId === projectId) {
      if (closeForRevokedProject()) sendEvent('overview', buildDashboardOverview(res.locals.session.permissions, sub, projectId));
    }
  };

  dashboardEvents.on('jobsChanged', onJobsChanged);
  if (hasPermission(res.locals.session.permissions, PermissionFlag.viewLogs)) dashboardEvents.on('logAdded', onLogAdded);
  dashboardEvents.on('historyAdded', onHistoryAdded);
  dashboardEvents.on('presenceChanged', onPresenceChanged);
  dashboardEvents.on('projectChanged', onProjectChanged);
  dashboardEvents.on('projectsChanged', onProjectChanged);

  const heartbeat = setInterval(() => {
    if (closeForRevokedProject()) res.write(': ping\n\n');
  }, 15_000);

  res.raw.once('close', () => {
    unregisterDashboardConnection();
    clearInterval(heartbeat);
    unregisterPresence(sub);
    dashboardEvents.off('jobsChanged', onJobsChanged);
    dashboardEvents.off('logAdded', onLogAdded);
    dashboardEvents.off('historyAdded', onHistoryAdded);
    dashboardEvents.off('presenceChanged', onPresenceChanged);
    dashboardEvents.off('projectChanged', onProjectChanged);
    dashboardEvents.off('projectsChanged', onProjectChanged);
  });
});

function resolveRequestProjectId(req: Request, res: Response, source: 'body' | 'query', options: { requireActive?: boolean } = {}): string | undefined {
  const value = source === 'body' ? req.body?.projectId : req.query.projectId;
  if (value !== undefined && (typeof value !== 'string' || !projectIdentifierPattern.test(value))) {
    res.status(400).json({ error: 'projectId must be a valid project identifier' });
    return undefined;
  }
  const projectId = typeof value === 'string' ? value : DEFAULT_PROJECT_ID;
  const project = getProject(projectId);
  if (!project || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, projectId)) {
    res.status(404).json({ error: 'project not found' });
    return undefined;
  }
  if (options.requireActive && project.archivedAt !== undefined) {
    res.status(409).json({ error: 'project is archived' });
    return undefined;
  }
  return projectId;
}

dashboardRouter.get('/v1/dashboard/discord/status', canViewDiscordPerks, (_req, res) => {
  res.json({ botEnabled: discordBotEnabled, guilds: getDiscordGuilds() });
});

dashboardRouter.get('/v1/dashboard/discord/guilds', canViewDiscordPerks, async (_req, res) => {
  res.json({ guilds: await fetchBotGuilds() });
});

dashboardRouter.post('/v1/dashboard/discord/guilds', canManageDiscordPerks, (req, res) => {
  const rawGuilds: unknown = req.body?.guilds;
  const guildRecords: { id: string; name: string; icon: string | null }[] | undefined = Array.isArray(rawGuilds)
    ? ((rawGuilds
        .filter((guild: unknown): guild is { id: string; name: string; icon: string | null } => {
          const candidate = guild as Record<string, unknown>;
          return (
            typeof guild === 'object' &&
            guild !== null &&
            typeof candidate.id === 'string' &&
            typeof candidate.name === 'string' &&
            (typeof candidate.icon === 'string' || candidate.icon === null)
          );
        }) as { id: string; name: string; icon: string | null }[])
        .map((guild) => ({ id: guild.id.trim(), name: guild.name.trim(), icon: guild.icon }))
        .filter((guild) => guild.id && guild.name))
    : undefined;
  if (!guildRecords) {
    res.status(400).json({ error: 'guilds must be an array of Discord guilds' });
    return;
  }
  setDiscordGuilds(guildRecords, res.locals.session.sub);
  res.json({ ok: true, guilds: getDiscordGuilds() });
});

dashboardRouter.get('/v1/dashboard/discord/roles', canViewDiscordPerks, async (req, res) => {
  const guildId = typeof req.query.guildId === 'string' ? req.query.guildId : '';
  if (!getDiscordGuilds().some((guild) => guild.id === guildId)) {
    res.json({ roles: [] });
    return;
  }
  res.json({ roles: await fetchGuildRoles(guildId) });
});

dashboardRouter.get('/v1/dashboard/discord/perks', canViewDiscordPerks, (_req, res) => {
  res.json({ perks: getDiscordRolePerks() });
});

dashboardRouter.post('/v1/dashboard/discord/perks', canManageDiscordPerks, (req, res) => {
  const guildId = typeof req.body?.guildId === 'string' ? req.body.guildId.trim() : '';
  const guildName = typeof req.body?.guildName === 'string' ? req.body.guildName.trim() : '';
  const guildIcon = typeof req.body?.guildIcon === 'string' ? req.body.guildIcon : null;
  const discordRoleId = typeof req.body?.discordRoleId === 'string' ? req.body.discordRoleId.trim() : '';
  const discordRoleName = typeof req.body?.discordRoleName === 'string' ? req.body.discordRoleName.trim() : '';
  const discordRoleColor = typeof req.body?.discordRoleColor === 'number' && Number.isInteger(req.body.discordRoleColor) ? req.body.discordRoleColor : -1;
  const appRoleId = typeof req.body?.appRoleId === 'string' ? req.body.appRoleId.trim() : '';
  if (!guildId || !guildName || !discordRoleId || !discordRoleName || discordRoleColor < 0 || !appRoleId) {
    res.status(400).json({ error: 'guild and Discord role details plus appRoleId are required' });
    return;
  }
  if (!getDiscordGuilds().some((guild) => guild.id === guildId)) {
    res.status(400).json({ error: 'guild is not selected for Discord role perks' });
    return;
  }
  const targetRole = listRoles().find((role) => role.id === appRoleId && !role.isDefault);
  if (!targetRole) {
    res.status(400).json({ error: 'appRoleId must reference a non-default dashboard role' });
    return;
  }
  if (!canGrantBits(res.locals.session.permissions, effectiveBitsForRoleIds([appRoleId], listRoles()))) {
    res.status(403).json({ error: "you can't map a Discord role to permissions you don't have yourself" });
    return;
  }
  res.status(201).json(
    createDiscordRolePerk(
      { id: guildId, name: guildName, icon: guildIcon },
      { id: discordRoleId, name: discordRoleName, color: discordRoleColor },
      appRoleId,
      res.locals.session.sub,
    ),
  );
});

dashboardRouter.delete('/v1/dashboard/discord/perks/:id', canManageDiscordPerks, (req, res) => {
  const ok = deleteDiscordRolePerk(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(404).json({ error: 'perk not found' });
    return;
  }
  res.json({ ok: true });
});
