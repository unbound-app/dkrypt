import { Router, type Request, type Response } from '#http.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { dashboardEvents, getOnlineUsernames, nextDashboardSequence, registerDashboardConnection, registerPresence, unregisterPresence } from '#events.js';
import type { LogEntry } from '#logger.js';
import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';
import { requireSession } from '#session.js';
import { recordDashboardSessionActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import {
  DEFAULT_PROJECT_ID,
  getProject,
  getUserEffectivePermissions,
  type JobHistoryEntry,
} from '#store/state.js';

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
