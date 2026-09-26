import { Router, type Request, type Response } from '#http.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { validate as validateCronExpr } from 'node-cron';
import { config, discordBotEnabled } from '#config.js';
import { fetchBotGuilds, fetchGuildRoles } from '#discord.js';
import { dashboardEvents, emitJobsChanged, getOnlineUsernames, nextDashboardSequence, registerDashboardConnection, registerPresence, unregisterPresence } from '#events.js';
import { blockDuringMaintenance } from '#maintenance.js';
import { jobSummary, streamFilePath } from '#jobs/http.js';
import { cancelJob, enqueueDecryptJob, getActiveJobs, getJob, getQueueInfo, prioritizeQueuedJob, reorderQueue } from '#jobs/store.js';
import type { LogEntry } from '#logger.js';
import { getRecentLogs } from '#logger.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';
import { canGrantBits, parseRoleIds } from '#dashboardAdminRules.js';
import { listAuthProfiles } from '#identity.js';
import { applyWatchSchedules, checkForTestFlightUpdate, checkForUpdate, triggerTickNow } from '#scheduler/index.js';
import { getGitHubRateLimitBudget, listDispatchRepos, listRepoWorkflows, validateDispatchTarget } from '#scheduler/github.js';
import { lookupAppMetadata, searchApps } from '#scheduler/itunes.js';
import { requirePermission, requireSession } from '#session.js';
import { recordDashboardSessionActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { getDeviceHealth, getDeviceInstallBlocker, getDeviceReadiness } from '#deviceHealth.js';
import { decodeCursor, nextCursor } from '#util/cursor.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
import { getTestFlightBridgeDiagnostics, listBuilds, listTrains, type TFBuild } from '#testflight.js';
import { nextCronRuns } from '#util/cron.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { rateLimitPerUser } from '#util/rateLimit.js';
import {
  decorateSearchResults,
  getVerifiedTestFlightCatalog,
  TestFlightCatalogUnavailableError,
} from '#testflightSubscriptions.js';
import { listAppVersions } from '#versions.js';
import {
  artifactDownloadName,
  artifactFileAvailable,
  artifactKeyForAppStoreVersion,
  getArtifactById,
  getArtifactByKey,
  listArtifacts,
  setArtifactPinned,
  touchArtifact,
} from '#artifacts.js';
import {
  addAllowedUser,
  approveApiKey,
  type AppWatch,
  bulkApproveApiKeys,
  bulkExtendApiKeyExpiry,
  bulkSetApiKeyAllowedBundleIds,
  bulkSetApiKeyDailyLimit,
  createApiKey,
  createDiscordRolePerk,
  createWatch,
  DEFAULT_PROJECT_ID,
  deleteDiscordRolePerk,
  deleteWatch,
  denyApiKey,
  effectiveBitsForRoleIds,
  getAllJobHistory,
  getApiKeyById,
  getApiKeyBundleUsage,
  getApiKeyOutcomeUsage,
  getApiKeyUsage,
  getAuditLog,
  getAverageJobDurationMs,
  getBundleStats,
  getDailyVolume,
  getDevice,
  getDiscordGuilds,
  getDiscordRolePerks,
  getEffectiveDevices,
  getEffectiveWatches,
  getProject,
  getUserEffectivePermissions,
  getInsightsSummary,
  getUserActivityStats,
  getJobHistoryEntryById,
  getPrimaryDevice,
  getSchedulerRunHistory,
  getStateDatabaseStatus,
  getGitHubBudgetTelemetry,
  getWatchHealthRollup,
  getUserPriority,
  getWatch,
  getWatchConfigIssues,
  getWatchDispatchTargets,
  getWebhookDeliveryLog,
  getAppCatalogEntries,
  getAppCatalogStats,
  isWatchSchedulable,
  type JobHistoryEntry,
  listAllApiKeysPage,
  listAllowedUsers,
  listApiKeysForOwner,
  listPendingApiKeys,
  listRoles,
  recordAudit,
  regenerateApiKey,
  removeAllowedUser,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  setApiKeyAllowTestFlight,
  setDiscordGuilds,
  setApiKeyMaxConcurrent,
  setApiKeyPriority,
  setUserPriority,
  upsertAppCatalogEntries,
  updateAllowedUserRoles,
  updateWatch,
  verifyLatestDatabaseBackup,
  wouldOrphanPermission,
} from '#store/state.js';

const canDecrypt = requirePermission(PermissionFlag.requestDecrypt);
const canManageStorage = requirePermission(PermissionFlag.manageAutomation);
const canRequestApiKeys = requirePermission(PermissionFlag.requestApiKeys);
const canAccessApi = requirePermission(PermissionFlag.createApiKeys);
const canViewOwnApiKeys = requirePermission(PermissionFlag.requestApiKeys, PermissionFlag.createApiKeys);
const canManageOrUseApiKeys = requirePermission(PermissionFlag.requestApiKeys, PermissionFlag.createApiKeys, PermissionFlag.manageApiKeys);
const canRevokeOwnedOrAnyApiKeys = requirePermission(PermissionFlag.createApiKeys, PermissionFlag.manageApiKeys);
const canViewApiKeys = requirePermission(
  PermissionFlag.viewApiKeys,
  PermissionFlag.manageApiKeys,
);
const canApproveApiKeys = requirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeyExpiry = requirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeyDailyLimits = requirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeyConcurrency = requirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeyTestFlight = requirePermission(PermissionFlag.manageApiKeys);
const canManageApiKeyPriority = requirePermission(PermissionFlag.manageApiKeys);
const canViewScheduler = requirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageWatches = requirePermission(PermissionFlag.manageAutomation);
const canManageSchedulerSettings = requirePermission(PermissionFlag.manageAutomation);

const canTriggerDispatch = requirePermission(PermissionFlag.manageAutomation);
const canViewLogs = requirePermission(PermissionFlag.viewLogs);
const canViewUsers = requirePermission(PermissionFlag.viewUsers, PermissionFlag.manageUsers);
const canManageUsers = requirePermission(PermissionFlag.manageUsers);
const canViewDiscordPerks = requirePermission(PermissionFlag.viewRoles, PermissionFlag.manageRoles);
const canManageDiscordPerks = requirePermission(PermissionFlag.manageRoles);
export const dashboardRouter = Router();

dashboardRouter.use(requireSession);
dashboardRouter.use((_req, res, next) => {
  recordDashboardSessionActivity(res.locals.session);
  next();
});

const deviceOrExternalRateLimit = rateLimitPerUser(10, 60_000);
const jobDiffRateLimit = rateLimitPerUser(30, 60_000);

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

dashboardRouter.get('/v1/dashboard/artifacts', canDecrypt, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined;
  const offset = cursor ? 0 : Number.parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
  const channel = req.query.channel === 'appstore' || req.query.channel === 'testflight' ? req.query.channel : undefined;
  const result = listArtifacts({
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) ? limit : 50,
    cursor,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    channel,
    projectIds: [projectId],
  });
  res.json({
    ...result,
    artifacts: result.artifacts.map((artifact) => ({
      ...artifact,
      filePath: undefined,
      fileUrl: `/v1/dashboard/artifacts/${artifact.id}/file`,
      createdAt: new Date(artifact.createdAt).toISOString(),
      lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
      pinnedAt: artifact.pinnedAt === undefined ? undefined : new Date(artifact.pinnedAt).toISOString(),
    })),
    nextCursor: result.nextCursor,
  });
});

dashboardRouter.put('/v1/dashboard/artifacts/:id/pin', canManageStorage, async (req, res) => {
  const artifact = getArtifactById(req.params.id);
  const permissions = res.locals.session.permissions;
  const sub = res.locals.session.sub;
  const allowed = artifact?.projectIds.some((projectId) => canAccessProject(sub, permissions, projectId)) ?? false;
  const requestedPinned = req.body?.pinned;
  if (!artifact || !artifactFileAvailable(artifact) || !allowed) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  if (typeof requestedPinned !== 'boolean') {
    res.status(400).json({ error: 'pinned must be a boolean' });
    return;
  }
  const result = await setArtifactPinned(artifact.id, requestedPinned);
  if (!result.artifact) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  if (result.changed) recordAudit(sub, requestedPinned ? 'artifact.pin' : 'artifact.unpin', artifact.id);
  res.json({
    ok: true,
    artifactId: artifact.id,
    pinned: result.artifact.pinnedAt !== undefined,
    pinnedAt: result.artifact.pinnedAt === undefined ? undefined : new Date(result.artifact.pinnedAt).toISOString(),
  });
});

dashboardRouter.get('/v1/dashboard/artifacts/:id/file', canDecrypt, async (req, res) => {
  const artifact = getArtifactById(req.params.id);
  const permissions = res.locals.session.permissions;
  const sub = res.locals.session.sub;
  const allowed = artifact?.projectIds.some((projectId) => canAccessProject(sub, permissions, projectId)) ?? false;
  if (!artifact || !artifactFileAvailable(artifact) || !allowed) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  await touchArtifact(artifact);
  await streamFilePath(artifact.filePath, req, res, artifactDownloadName(artifact), artifact.fileSizeBytes, artifact.id);
});

dashboardRouter.get('/v1/dashboard/webhooks', canViewLogs, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200);
  res.json({ deliveries: getWebhookDeliveryLog(limit) });
});

const HISTORY_CSV_COLUMNS = [
  'id',
  'bundleId',
  'externalVersionId',
  'versionLabel',
  'queuedBy',
  'status',
  'error',
  'sizeBytes',
  'source',
  'deviceId',
  'createdAt',
  'startedAt',
  'finishedAt',
] as const;

function csvCell(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

dashboardRouter.get('/v1/dashboard/jobs/export', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const entries = getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId);

  if (format === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-job-history.json"');
    res.json(entries);
    return;
  }

  const rows = [HISTORY_CSV_COLUMNS.join(',')];
  for (const e of entries) {
    rows.push(HISTORY_CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-job-history.csv"');
  res.send(rows.join('\n'));
});

dashboardRouter.get('/v1/dashboard/jobs/eta/:bundleId', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  res.json({ avgMs: getAverageJobDurationMs(req.params.bundleId, projectId) ?? null });
});

dashboardRouter.post('/v1/dashboard/jobs/bulk-preview', canDecrypt, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'body');
  if (!projectId) return;
  const rawIds: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown): id is string => typeof id === 'string') : [];
  const ids = [...new Set<string>(rawIds)].slice(0, 100);
  const activeJobs = getActiveJobs();
  const items = ids.flatMap((id) => {
    const entry = getJobHistoryEntryById(id);
    if (!entry || (entry.projectId ?? DEFAULT_PROJECT_ID) !== projectId) return [];
    const active = activeJobs.find((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && job.bundleId === entry.bundleId && job.externalVersionId === entry.externalVersionId && job.testflight?.build.id === entry.testflight?.build.id);
    return [{
      id: entry.id,
      bundleId: entry.bundleId,
      versionLabel: entry.versionLabel,
      status: entry.status,
      action: active ? 'join-existing' as const : 'queue' as const,
      reason: active ? `Already active as ${active.id.slice(0, 8)}` : undefined,
      estimatedDurationMs: getAverageJobDurationMs(entry.bundleId, projectId),
    }];
  });
  res.json({
    requested: ids.length,
    eligible: items.length,
    projectedQueueAdds: items.filter((item) => item.action === 'queue').length,
    estimatedDurationMs: items.filter((item) => item.action === 'queue').reduce((sum, item) => sum + (item.estimatedDurationMs ?? 0), 0),
    previousSizeBytes: items.reduce((sum, item) => sum + (getJobHistoryEntryById(item.id)?.sizeBytes ?? 0), 0),
    items,
  });
});

dashboardRouter.get('/v1/dashboard/jobs/slo', canViewScheduler, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const now = Date.now();
  const completed = getAllJobHistory().filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && job.status === 'done' && job.startedAt && job.finishedAt > job.startedAt);
  const durations = completed.map((job) => job.finishedAt - (job.startedAt as number)).sort((a, b) => a - b);
  const historicalP95Ms = durations.length === 0 ? null : durations[Math.ceil(durations.length * 0.95) - 1];
  const targetMs = historicalP95Ms ?? config.queueSloMinutes * 60_000;
  const jobs = getActiveJobs().filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId).map((job) => {
    const queue = job.status === 'queued' ? getQueueInfo(job.id) : undefined;
    const waitedMs = now - job.createdAt;
    const predictedStartMs = queue && historicalP95Ms !== null ? Math.max(0, queue.position - 1) * historicalP95Ms : null;
    const predictedCompletionMs = predictedStartMs === null || historicalP95Ms === null ? null : predictedStartMs + historicalP95Ms;
    return {
      id: job.id,
      bundleId: job.bundleId,
      status: job.status,
      waitedMs,
      predictedStartMs,
      predictedCompletionMs,
      objective: waitedMs > targetMs || (predictedCompletionMs !== null && waitedMs + predictedCompletionMs > targetMs) ? 'breached' : 'within',
    };
  });
  res.json({ targetMs, historicalP95Ms, jobs });
});

dashboardRouter.get('/v1/dashboard/jobs/stats/:bundleId', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  res.json(getBundleStats(req.params.bundleId, projectId));
});

dashboardRouter.get('/v1/dashboard/jobs/volume', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
  res.json({ days: getDailyVolume(days, projectId) });
});

dashboardRouter.get('/v1/dashboard/jobs/diff', jobDiffRateLimit, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const bundleId = typeof req.query.bundleId === 'string' ? req.query.bundleId : '';
  const aId = typeof req.query.a === 'string' ? req.query.a : '';
  const bId = typeof req.query.b === 'string' ? req.query.b : '';
  const a = getJobHistoryEntryById(aId);
  const b = getJobHistoryEntryById(bId);
  if (!a || !b || (a.projectId ?? DEFAULT_PROJECT_ID) !== projectId || (b.projectId ?? DEFAULT_PROJECT_ID) !== projectId) {
    res.status(404).json({ error: 'one or both job history entries not found' });
    return;
  }
  if (a.bundleId !== bundleId || b.bundleId !== bundleId) {
    res.status(400).json({ error: 'both entries must belong to bundleId' });
    return;
  }

  const plistA = a.ipaInfoPlist ?? {};
  const plistB = b.ipaInfoPlist ?? {};
  const keys = new Set([...Object.keys(plistA), ...Object.keys(plistB)]);
  const plistDiff: { key: string; before: unknown; after: unknown }[] = [];
  for (const key of keys) {
    if (JSON.stringify(plistA[key]) !== JSON.stringify(plistB[key])) {
      plistDiff.push({ key, before: plistA[key], after: plistB[key] });
    }
  }
  plistDiff.sort((x, y) => x.key.localeCompare(y.key));

  res.json({
    a: { id: a.id, versionLabel: a.versionLabel, sizeBytes: a.sizeBytes, finishedAt: a.finishedAt, metadata: a.ipaMetadata },
    b: { id: b.id, versionLabel: b.versionLabel, sizeBytes: b.sizeBytes, finishedAt: b.finishedAt, metadata: b.ipaMetadata },
    sizeDeltaBytes: (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
    plistDiff,
  });
});

dashboardRouter.get('/v1/dashboard/insights', (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const topAppsLimit = Math.min(Math.max(Number.parseInt(String(req.query.topApps ?? '5'), 10) || 5, 1), 25);
  const trendDays = Math.min(Math.max(Number.parseInt(String(req.query.trendDays ?? '14'), 10) || 14, 1), 90);
  res.json(getInsightsSummary(topAppsLimit, trendDays, projectId));
});

dashboardRouter.get('/v1/dashboard/failure-patterns', canViewScheduler, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const normalize = (message: string) => message
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/(?:authorization:\s*bearer\s+|(?:token|secret|key|cookie)\s*[:=]\s*)[^\s,;"']+/gi, '[redacted]')
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[id]')
    .replace(/\b\d{4,}\b/g, '[number]')
    .slice(0, 180);
  const patterns = new Map<string, { count: number; firstSeen: number; lastSeen: number; bundleIds: Set<string> }>();
  for (const job of getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.status === 'failed' && entry.error)) {
    const key = normalize(job.error as string);
    const current = patterns.get(key) ?? { count: 0, firstSeen: job.finishedAt, lastSeen: job.finishedAt, bundleIds: new Set<string>() };
    current.count += 1;
    current.firstSeen = Math.min(current.firstSeen, job.finishedAt);
    current.lastSeen = Math.max(current.lastSeen, job.finishedAt);
    current.bundleIds.add(job.bundleId);
    patterns.set(key, current);
  }
  res.json({ patterns: [...patterns.entries()].map(([message, pattern]) => ({ message, count: pattern.count, firstSeen: pattern.firstSeen, lastSeen: pattern.lastSeen, bundleIds: [...pattern.bundleIds] })).sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen).slice(0, 20) });
});

dashboardRouter.get('/v1/dashboard/storage-forecast', canViewScheduler, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const cutoff = Date.now() - 30 * 86_400_000;
  const completed = getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.status === 'done' && entry.finishedAt >= cutoff && entry.sizeBytes && entry.sizeBytes > 0);
  const bytesPerDay = completed.reduce((total, entry) => total + (entry.sizeBytes ?? 0), 0) / 30;
  const disk = getDiskUsage(config.artifactDir);
  if (!disk) {
    res.status(503).json({ error: 'output storage is unavailable' });
    return;
  }
  res.json({
    freeBytes: disk.freeBytes,
    bytesPerDay,
    daysRemaining: bytesPerDay > 0 ? Math.floor(disk.freeBytes / bytesPerDay) : null,
    sampleCount: completed.length,
  });
});

dashboardRouter.get('/v1/dashboard/support-bundle', canManageWatches, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const clean = (value: string | undefined): string | undefined => value?.replace(/https?:\/\/\S+/g, '[redacted-url]').replace(/(?:token|secret|key)=\S+/gi, '$1=[redacted]');
  const cleanStructured = (value: unknown): unknown => {
    if (typeof value === 'string') return clean(value) ?? value;
    if (Array.isArray(value)) return value.map(cleanStructured);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, /token|secret|password|private.?key/i.test(key) ? '[redacted]' : cleanStructured(entry)]));
  };
  const jobs = getAllJobHistory()
    .filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId)
    .slice(0, 100)
    .map(({ id, bundleId, status, source, versionLabel, createdAt, startedAt, finishedAt, sizeBytes, error }) => ({
      id, bundleId, status, source, versionLabel, createdAt, startedAt, finishedAt, sizeBytes, error: clean(error),
    }));
  res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-support-bundle.json"');
  res.json({
    generatedAt: new Date().toISOString(),
    deployment: { ref: process.env.BUILD_REF ?? 'development', node: process.version },
    database: getStateDatabaseStatus(),
    latestBackup: verifyLatestDatabaseBackup(),
    disk: getDiskUsage(config.artifactDir),
    catalog: getAppCatalogStats(),
    devices: getEffectiveDevices().map(({ id, name, enabled, isPrimary }) => ({ id, name, enabled, isPrimary })),
    watches: getEffectiveWatches().map((watch) => ({ bundleId: watch.bundleId, enabled: watch.enabled, pollCron: watch.pollCron, destinations: getWatchDispatchTargets(watch).length })),
    watchHealth: getWatchHealthRollup(),
    schedulerRuns: getSchedulerRunHistory(50).map((run) => ({ ...run, appStore: { ...run.appStore, reason: clean(run.appStore.reason) ?? '' }, testflight: { ...run.testflight, reason: clean(run.testflight.reason) ?? '' } })),
    logs: getRecentLogs({ limit: 200, filter: (entry) => logBelongsToProject(entry, projectId) }).logs.map((entry) => ({ ...entry, message: clean(entry.message) ?? entry.message, meta: cleanStructured(entry.meta) })),
    jobs,
  });
});

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

dashboardRouter.get('/v1/dashboard/search', async (req, res) => {
  const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!term || term.length > 200) {
    res.status(400).json({ error: 'query param q is required' });
    return;
  }

  try {
    const results = await decorateSearchResults(await searchApps(term));
    upsertAppCatalogEntries(
      results.map((result) => ({
        bundleId: result.bundleId,
        displayName: result.trackName,
        iconUrl: result.artworkUrl,
        trackId: result.trackId,
        sellerName: result.sellerName,
        category: result.category,
      })),
    );
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/apps/metadata', async (req, res) => {
  const rawBundleIds: string = typeof req.query.bundleIds === 'string' ? req.query.bundleIds : '';
  const parsedBundleIds: string[] = rawBundleIds
    .split(',')
    .map((value: string) => value.trim())
    .filter((value: string) => BUNDLE_ID_RE.test(value));
  const bundleIds: string[] = Array.from(new Set<string>(parsedBundleIds)).slice(0, 200);
  if (bundleIds.length === 0) {
    res.json({ entries: [] });
    return;
  }

  const existing = new Map(getAppCatalogEntries(bundleIds).map((entry) => [entry.bundleId, entry]));
  const missing = bundleIds.filter((bundleId) => !existing.has(bundleId)).slice(0, 40);

  if (missing.length > 0) {
    const fetched = await Promise.all(
      missing.map(async (bundleId) => {
        try {
          const metadata = await lookupAppMetadata(bundleId);
          return {
            bundleId: metadata.bundleId,
            displayName: metadata.trackName,
            iconUrl: metadata.artworkUrl,
            trackId: metadata.trackId,
            sellerName: metadata.sellerName,
            category: metadata.category,
            description: metadata.description,
            screenshots: metadata.screenshots,
            releaseNotes: metadata.releaseNotes,
            price: metadata.price,
          };
        } catch {
          return null;
        }
      }),
    );
    upsertAppCatalogEntries(fetched.filter((entry): entry is NonNullable<typeof entry> => !!entry));
  }

  res.json({ entries: getAppCatalogEntries(bundleIds) });
});

dashboardRouter.get('/v1/dashboard/apps/cache', canViewScheduler, (_req, res) => {
  res.json(getAppCatalogStats());
});

dashboardRouter.post('/v1/dashboard/apps/metadata/refresh', canManageWatches, async (req, res) => {
  const rawBundleIds: unknown[] = Array.isArray(req.body?.bundleIds) ? req.body.bundleIds : [];
  const validBundleIds = rawBundleIds.filter(
    (bundleId): bundleId is string => typeof bundleId === 'string' && BUNDLE_ID_RE.test(bundleId),
  );
  const bundleIds = Array.from(new Set<string>(validBundleIds)).slice(0, 40);
  if (bundleIds.length === 0) {
    res.status(400).json({ error: 'at least one valid bundle ID is required' });
    return;
  }

  const fetched = await Promise.all(
    bundleIds.map(async (bundleId) => {
      try {
        const metadata = await lookupAppMetadata(bundleId);
        return {
          bundleId: metadata.bundleId,
          displayName: metadata.trackName,
          iconUrl: metadata.artworkUrl,
          trackId: metadata.trackId,
          sellerName: metadata.sellerName,
          category: metadata.category,
          description: metadata.description,
          screenshots: metadata.screenshots,
          releaseNotes: metadata.releaseNotes,
          price: metadata.price,
        };
      } catch {
        return null;
      }
    }),
  );
  const entries = upsertAppCatalogEntries(fetched.filter((entry): entry is NonNullable<typeof entry> => !!entry));
  res.json({ entries });
});

const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

dashboardRouter.post('/v1/dashboard/decrypt', canDecrypt, blockDuringMaintenance, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'body', { requireActive: true });
  if (!projectId) return;
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId is required and must look like a bundle identifier' });
    return;
  }

  const externalVersionId =
    typeof req.body?.externalVersionId === 'string' && EXTERNAL_VERSION_ID_RE.test(req.body.externalVersionId)
      ? req.body.externalVersionId
      : undefined;

  const versionLabel = typeof req.body?.versionLabel === 'string' ? req.body.versionLabel.trim().slice(0, 64) || undefined : undefined;

  const preferPrimary = req.body?.preferPrimary === true;
  const preferredDeviceId = preferPrimary ? getPrimaryDevice()?.id : undefined;

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    externalVersionId,
    undefined,
    versionLabel,
    res.locals.session.sub,
    getUserPriority(res.locals.session.sub),
    preferredDeviceId,
    undefined,
    projectId,
  );
  res.status(202).json(jobSummary(job));
});

dashboardRouter.post('/v1/dashboard/decrypt/preflight', canDecrypt, async (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'body', { requireActive: true });
  if (!projectId) return;
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId is required and must look like a bundle identifier' });
    return;
  }
  const testflight = req.body?.testflight === true;
  const versionLabel = typeof req.body?.versionLabel === 'string' ? req.body.versionLabel.trim().slice(0, 64) || undefined : undefined;
  const installSizeBytes = typeof req.body?.installSizeBytes === 'number' && Number.isFinite(req.body.installSizeBytes) && req.body.installSizeBytes > 0 ? req.body.installSizeBytes : undefined;
  const requestedDeviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  const requestedDevice = requestedDeviceId ? getDevice(requestedDeviceId) : undefined;
  if (requestedDeviceId && (!requestedDevice || !requestedDevice.enabled)) {
    res.status(400).json({ error: 'deviceId must refer to an enabled device' });
    return;
  }
  let verifiedCatalog = [] as Awaited<ReturnType<typeof getVerifiedTestFlightCatalog>>;
  if (testflight) {
    try {
      verifiedCatalog = await getVerifiedTestFlightCatalog({ requireAllDevices: true });
    } catch (error) {
      if (error instanceof TestFlightCatalogUnavailableError) {
        res.status(503).json({ error: error.message, code: 'testflight_catalog_unavailable' });
        return;
      }
      throw error;
    }
  }
  const verifiedTestFlightApp = testflight
    ? verifiedCatalog.find((entry) => entry.bundleId === bundleId)
    : undefined;
  if (testflight && !verifiedTestFlightApp) {
    res.status(409).json({ error: 'TestFlight access must be verified on an enabled device before queueing' });
    return;
  }
  if (requestedDevice && verifiedTestFlightApp && !verifiedTestFlightApp.devices.some((device) => device.id === requestedDevice.id)) {
    res.status(409).json({ error: 'TestFlight access is not verified on the selected device' });
    return;
  }
  const verifiedDeviceIds = verifiedTestFlightApp ? new Set(verifiedTestFlightApp.devices.map((device) => device.id)) : undefined;
  const devices = requestedDevice
    ? [requestedDevice]
    : getEffectiveDevices().filter((device) => device.enabled && (!verifiedDeviceIds || verifiedDeviceIds.has(device.id)));
  const primary = devices.find((device) => device.isPrimary) ?? devices[0];
  const checks = await Promise.all(devices.map(async (device) => {
    try {
      const health = await getDeviceHealth(device.id, true);
      const blockers: string[] = [];
      if (!health.reachable) blockers.push(health.error ?? 'device is unreachable');
      if (health.internetAccess === false) blockers.push('device cannot reach Apple services');
      const installBlocker = getDeviceInstallBlocker(health, installSizeBytes);
      if (installBlocker) blockers.push(installBlocker);
      if (health.readiness?.state === 'blocked') blockers.push(...(health.readiness.reasons.length > 0 ? health.readiness.reasons : ['device readiness is blocked']));
      if (testflight && health.testFlightBridgeReachable === false) blockers.push('TestFlight bridge is unresponsive');
      return {
        id: device.id,
        name: device.name,
        isPrimary: device.id === primary?.id,
        ready: blockers.length === 0,
        blockers: [...new Set(blockers)],
        readiness: health.readiness ?? getDeviceReadiness(health),
        reachable: health.reachable,
        storageFreeBytes: health.storageFreeBytes,
        batteryPercent: health.batteryPercent,
      };
    } catch (error) {
      return {
        id: device.id,
        name: device.name,
        isPrimary: device.id === primary?.id,
        ready: false,
        blockers: [error instanceof Error ? error.message : 'device health check failed'],
        reachable: false,
      };
    }
  }));
  res.json({
    bundleId,
    versionLabel,
    testflight,
    installSizeBytes,
    estimatedDurationMs: getAverageJobDurationMs(bundleId, projectId),
    queueLength: getActiveJobs().filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId).length,
    canQueue: checks.some((check) => check.ready),
    devices: checks,
  });
});

dashboardRouter.get('/v1/dashboard/versions/:bundleId', async (req, res) => {
  const bundleId = req.params.bundleId;
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId must look like a bundle identifier' });
    return;
  }

  try {
    const versions = await listAppVersions(bundleId, req.query.force === 'true');
    res.json({
      versions: versions.map((version) => ({
        ...version,
        artifactId: getArtifactByKey(artifactKeyForAppStoreVersion(bundleId, version.displayVersion ?? version.externalVersionId ?? 'latest', version.externalVersionId))?.id,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/github/rate-limit', canManageWatches, async (_req, res) => {
  if (!config.ghToken) {
    res.status(409).json({ error: 'GH_TOKEN is not configured' });
    return;
  }
  try {
    const budget = await getGitHubRateLimitBudget(true);
    res.json(budget ? { limit: budget.limit, remaining: budget.remaining, reset: Math.floor(budget.resetAt / 1000) } : {});
  } catch (err) {
    res.status(502).json({ error: `GitHub rate-limit lookup failed: ${String(err)}` });
  }
});

function serializeWatch(w: AppWatch) {
  return { ...w, schedulable: isWatchSchedulable(w), configIssues: getWatchConfigIssues(w) };
}

dashboardRouter.get('/v1/dashboard/watches', canViewScheduler, (_req, res) => {
  res.json({ watches: getEffectiveWatches()
    .filter((watch) => canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID))
    .map(serializeWatch) });
});

dashboardRouter.get('/v1/dashboard/watches/export', canManageWatches, (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-watches.json"');
  res.json({ version: 1, watches: getEffectiveWatches().filter((watch) => canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) });
});

dashboardRouter.get('/v1/dashboard/watches/health', canViewScheduler, (_req, res) => {
  const accessibleWatchIds = new Set(getEffectiveWatches()
    .filter((watch) => canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID))
    .map((watch) => watch.id));
  res.json({ watches: getWatchHealthRollup().filter((watch) => accessibleWatchIds.has(watch.watchId)) });
});

dashboardRouter.get('/v1/dashboard/watches/calendar', canViewScheduler, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  const requestedFromAt = Number.parseInt(String(req.query.fromAt ?? ''), 10);
  const now = Date.now();
  const fromAt = Number.isFinite(requestedFromAt) && Math.abs(requestedFromAt - now) <= 90 * 24 * 60 * 60 * 1000 ? requestedFromAt : now;
  const untilAt = fromAt + hours * 60 * 60 * 1000;
  const maxRuns = 200;
  const runs: { watchId: string; bundleId: string; at: number }[] = [];
  const pending = getEffectiveWatches()
    .filter((watch) => (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId && isWatchSchedulable(watch))
    .flatMap((watch) => {
      const at = nextCronRuns(watch.pollCron, untilAt, fromAt, 1)[0];
      return at === undefined ? [] : [{ watch, at }];
    });
  while (pending.length > 0 && runs.length < maxRuns) {
    pending.sort((a, b) => a.at - b.at);
    const next = pending.shift() as { watch: AppWatch; at: number };
    runs.push({ watchId: next.watch.id, bundleId: next.watch.bundleId, at: next.at });
    const followingAt = nextCronRuns(next.watch.pollCron, untilAt, next.at, 1)[0];
    if (followingAt !== undefined) pending.push({ watch: next.watch, at: followingAt });
  }
  res.json({ fromAt, untilAt, runs, truncated: pending.length > 0 });
});

dashboardRouter.get('/v1/dashboard/github/budget-history', canManageWatches, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '30'), 10) || 30, 1), 200);
  const projectId = resolveRequestProjectId(req, res, 'query');
  if (!projectId) return;
  const watchIds = new Set(getEffectiveWatches()
    .filter((watch) => (watch.projectId ?? DEFAULT_PROJECT_ID) === projectId)
    .map((watch) => watch.id));
  res.json({ entries: getGitHubBudgetTelemetry(200).filter((entry) => watchIds.has(entry.watchId)).slice(0, limit) });
});

dashboardRouter.get('/v1/dashboard/github/repos', canManageWatches, async (_req, res) => {
  if (!config.ghToken) {
    res.status(409).json({ error: 'GH_TOKEN is not configured' });
    return;
  }

  try {
    const repos = await listDispatchRepos();
    res.json({ repos });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/github/workflows', canManageWatches, async (req, res) => {
  if (!config.ghToken) {
    res.status(409).json({ error: 'GH_TOKEN is not configured' });
    return;
  }

  const repo = typeof req.query.repo === 'string' ? req.query.repo.trim() : '';
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    res.status(400).json({ error: 'repo query must be owner/repo' });
    return;
  }

  try {
    const workflows = await listRepoWorkflows(repo);
    res.json({ workflows });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

interface WatchInput {
  projectId?: string;
  bundleId: string;
  repo: string;
  ghWorkflowFile: string;
  dispatchTargets?: { repo: string; ghWorkflowFile: string; mode?: 'repository_dispatch' | 'workflow_dispatch'; ref?: string; inputs?: Record<string, string> }[];
  pollCron: string;
  enabled?: boolean;
  webhookUrl?: string;
  testFlightPolicy?: 'latest' | 'latestNonExpired' | 'train';
  testFlightTrain?: string;
}

function parseWatchInput(body: unknown): WatchInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const bundleId = typeof b.bundleId === 'string' ? b.bundleId.trim() : '';
  if (!bundleId) return undefined;
  const dispatchTargets = Array.isArray(b.dispatchTargets)
    ? b.dispatchTargets
        .filter((target): target is Record<string, unknown> => typeof target === 'object' && target !== null)
        .map((target) => ({
          repo: typeof target.repo === 'string' ? target.repo.trim() : '',
          ghWorkflowFile: typeof target.ghWorkflowFile === 'string' ? target.ghWorkflowFile.trim() : '',
          mode: target.mode === 'workflow_dispatch' ? 'workflow_dispatch' as const : 'repository_dispatch' as const,
          ref: typeof target.ref === 'string' ? target.ref.trim() || undefined : undefined,
          inputs: parseDispatchInputs(target.inputs),
        }))
        .filter((target) => /^[\w.-]+\/[\w.-]+$/.test(target.repo) && target.ghWorkflowFile.length > 0)
    : undefined;
  const primary = dispatchTargets?.[0];
  return {
    projectId: typeof b.projectId === 'string' ? b.projectId : undefined,
    bundleId,
    repo: primary?.repo ?? (typeof b.repo === 'string' ? b.repo.trim() : ''),
    ghWorkflowFile: primary?.ghWorkflowFile ?? (typeof b.ghWorkflowFile === 'string' ? b.ghWorkflowFile.trim() : 'remote-ipa-update.yml'),
    dispatchTargets,
    pollCron: typeof b.pollCron === 'string' ? b.pollCron.trim() : '0 * * * *',
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    webhookUrl: typeof b.webhookUrl === 'string' ? b.webhookUrl.trim() || undefined : undefined,
    testFlightPolicy:
      b.testFlightPolicy === 'latestNonExpired' || b.testFlightPolicy === 'train' ? b.testFlightPolicy : 'latest',
    testFlightTrain: typeof b.testFlightTrain === 'string' ? b.testFlightTrain.trim() || undefined : undefined,
  };
}

function parseDispatchInputs(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const inputs = Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => entry[0].trim().length > 0 && typeof entry[1] === 'string')
    .slice(0, 20);
  if (inputs.length === 0) return undefined;
  return Object.fromEntries(inputs.map(([key, item]) => [key.trim().slice(0, 100), item.trim().slice(0, 500)]));
}

dashboardRouter.post('/v1/dashboard/watches', canManageWatches, (req, res) => {
  const input = parseWatchInput(req.body);
  if (!input) {
    res.status(400).json({ error: 'bundleId is required' });
    return;
  }
  const projectId = resolveRequestProjectId(req, res, 'body', { requireActive: true });
  if (!projectId) return;
  input.projectId = projectId;
  if (input.pollCron && !validateCronExpr(input.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
    return;
  }
  if (input.testFlightPolicy === 'train' && !input.testFlightTrain) {
    res.status(400).json({ error: 'testFlightTrain is required when testFlightPolicy is train' });
    return;
  }
  const result = createWatch(input, res.locals.session.sub);
  if (!result.ok) {
    res.status(409).json({ error: result.error });
    return;
  }
  applyWatchSchedules();
  emitJobsChanged();
  res.status(201).json(serializeWatch(result.watch as AppWatch));
});

dashboardRouter.patch('/v1/dashboard/watches/:id', canManageWatches, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<WatchInput> = {};
  if (typeof body.bundleId === 'string' && body.bundleId.trim()) patch.bundleId = body.bundleId.trim();
  if (typeof body.repo === 'string') patch.repo = body.repo.trim();
  if (typeof body.ghWorkflowFile === 'string') patch.ghWorkflowFile = body.ghWorkflowFile.trim();
  if (Array.isArray(body.dispatchTargets)) {
    patch.dispatchTargets = body.dispatchTargets
      .filter((target): target is Record<string, unknown> => typeof target === 'object' && target !== null)
        .map((target) => ({
          repo: typeof target.repo === 'string' ? target.repo.trim() : '',
          ghWorkflowFile: typeof target.ghWorkflowFile === 'string' ? target.ghWorkflowFile.trim() : '',
          mode: target.mode === 'workflow_dispatch' ? 'workflow_dispatch' as const : 'repository_dispatch' as const,
          ref: typeof target.ref === 'string' ? target.ref.trim() || undefined : undefined,
          inputs: parseDispatchInputs(target.inputs),
      }))
      .filter((target) => /^[\w.-]+\/[\w.-]+$/.test(target.repo) && target.ghWorkflowFile.length > 0);
    if (patch.dispatchTargets[0]) {
      patch.repo = patch.dispatchTargets[0].repo;
      patch.ghWorkflowFile = patch.dispatchTargets[0].ghWorkflowFile;
    }
  }
  if (typeof body.pollCron === 'string') patch.pollCron = body.pollCron.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.webhookUrl === 'string') patch.webhookUrl = body.webhookUrl.trim() || undefined;
  if (body.testFlightPolicy === 'latest' || body.testFlightPolicy === 'latestNonExpired' || body.testFlightPolicy === 'train') {
    patch.testFlightPolicy = body.testFlightPolicy;
  }
  if (typeof body.testFlightTrain === 'string') patch.testFlightTrain = body.testFlightTrain.trim() || undefined;
  if (Object.hasOwn(body, 'projectId')) {
    const projectId = resolveRequestProjectId(req, res, 'body', { requireActive: true });
    if (!projectId) return;
    patch.projectId = projectId;
  }

  if (patch.pollCron && !validateCronExpr(patch.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
    return;
  }
  const existingWatch = getWatch(req.params.id);
  if (!existingWatch || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, existingWatch.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  if ((patch.testFlightPolicy ?? existingWatch.testFlightPolicy) === 'train' && !(patch.testFlightTrain ?? existingWatch.testFlightTrain)) {
    res.status(400).json({ error: 'testFlightTrain is required when testFlightPolicy is train' });
    return;
  }

  const result = updateWatch(req.params.id, patch, res.locals.session.sub);
  if (!result.ok) {
    res.status(result.error === 'watch not found' ? 404 : 409).json({ error: result.error });
    return;
  }
  applyWatchSchedules();
  emitJobsChanged();
  res.json(serializeWatch(result.watch as AppWatch));
});

dashboardRouter.delete('/v1/dashboard/watches/:id', canManageWatches, (req, res) => {
  const watch = getWatch(req.params.id);
  if (!watch || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  const ok = deleteWatch(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  applyWatchSchedules();
  emitJobsChanged();
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/watches/import', canManageWatches, (req, res) => {
  const body = req.body as { watches?: unknown } | undefined;
  const rawWatches = Array.isArray(body?.watches) ? body.watches : [];
  if (rawWatches.length === 0 || rawWatches.length > 100) {
    res.status(400).json({ error: 'watches must contain between 1 and 100 entries' });
    return;
  }
  const imported: AppWatch[] = [];
  const skipped: string[] = [];
  for (const rawWatch of rawWatches) {
    const input = parseWatchInput(rawWatch);
    if (!input || !validateCronExpr(input.pollCron) || (input.testFlightPolicy === 'train' && !input.testFlightTrain)) {
      skipped.push('invalid watch');
      continue;
    }
    const projectId = input.projectId ?? DEFAULT_PROJECT_ID;
    if (!canAccessProject(res.locals.session.sub, res.locals.session.permissions, projectId) || getProject(projectId)?.archivedAt !== undefined) {
      skipped.push(`${input.bundleId}: project is unavailable`);
      continue;
    }
    input.projectId = projectId;
    const result = createWatch({ ...input, enabled: false }, res.locals.session.sub);
    if (result.watch) imported.push(serializeWatch(result.watch));
    else skipped.push(result.error ?? 'could not import watch');
  }
  if (imported.length === 0) {
    res.status(400).json({ error: skipped[0] ?? 'no watches were imported' });
    return;
  }
  recordAudit(res.locals.session.sub, 'watch.import', 'watches', `${imported.length} imported disabled`);
  applyWatchSchedules();
  emitJobsChanged();
  res.status(201).json({ watches: imported, skipped });
});

dashboardRouter.post('/v1/dashboard/watches/preview-dispatch-draft', canManageWatches, deviceOrExternalRateLimit, async (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const repo = typeof req.body?.repo === 'string' ? req.body.repo.trim() : '';
  if (!BUNDLE_ID_RE.test(bundleId) || !repo) {
    res.status(400).json({ error: 'bundleId and repo are required' });
    return;
  }
  const draft: AppWatch = {
    id: 'draft',
    bundleId,
    repo,
    ghWorkflowFile: '',
    pollCron: '',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  };
  const [appStore, testflight] = await Promise.all([checkForUpdate(draft), checkForTestFlightUpdate(draft)]);
  res.json({ ...appStore, testflight });
});

dashboardRouter.post('/v1/dashboard/watches/validate-dispatch-draft', canManageWatches, deviceOrExternalRateLimit, async (req, res) => {
  const rawTargets: unknown[] = Array.isArray(req.body?.targets) ? req.body.targets : [];
  if (rawTargets.length === 0 || rawTargets.length > 10) {
    res.status(400).json({ error: 'provide between 1 and 10 dispatch targets' });
    return;
  }
  const parsed = rawTargets.map((target) => {
    if (typeof target !== 'object' || target === null) return undefined;
    const value = target as Record<string, unknown>;
    const repo = typeof value.repo === 'string' ? value.repo.trim() : '';
    const ghWorkflowFile = typeof value.ghWorkflowFile === 'string' ? value.ghWorkflowFile.trim() : '';
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !ghWorkflowFile) return undefined;
    const rawInputs = typeof value.inputs === 'object' && value.inputs !== null ? value.inputs as Record<string, unknown> : {};
    const inputs = Object.fromEntries(Object.entries(rawInputs).filter(([, input]) => typeof input === 'string')) as Record<string, string>;
    return { repo, ghWorkflowFile, mode: value.mode === 'workflow_dispatch' ? 'workflow_dispatch' as const : 'repository_dispatch' as const, ref: typeof value.ref === 'string' && value.ref.trim() ? value.ref.trim() : undefined, inputs };
  });
  if (parsed.some((target) => !target)) {
    res.status(400).json({ error: 'each dispatch target needs a valid repository and workflow' });
    return;
  }
  const results = await Promise.all(parsed.map((target) => validateDispatchTarget(target!)));
  res.json({ results, ok: results.every((result) => result.ok) });
});

dashboardRouter.get('/v1/dashboard/watches/:id/preview-dispatch', canTriggerDispatch, deviceOrExternalRateLimit, async (req, res) => {
  const watch = getWatch(req.params.id);
  if (!watch || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  const [appStore, testflight] = await Promise.all([checkForUpdate(watch), checkForTestFlightUpdate(watch)]);
  res.json({ ...appStore, testflight });
});

dashboardRouter.get('/v1/dashboard/watches/:id/preview-dispatch/:source', canTriggerDispatch, deviceOrExternalRateLimit, async (req, res) => {
  const watch = getWatch(req.params.id);
  if (!watch || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }

  if (req.params.source === 'app-store') {
    res.json({ source: 'appStore', result: await checkForUpdate(watch) });
    return;
  }
  if (req.params.source === 'testflight') {
    res.json({ source: 'testflight', result: await checkForTestFlightUpdate(watch) });
    return;
  }
  res.status(400).json({ error: 'source must be app-store or testflight' });
});

dashboardRouter.post('/v1/dashboard/watches/:id/trigger-dispatch', canTriggerDispatch, async (req, res) => {
  const watch = getWatch(req.params.id);
  if (!watch || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, watch.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  const result = await triggerTickNow(req.params.id);
  res.status(result.ok ? 202 : 409).json(result);
});

dashboardRouter.get('/v1/dashboard/testflight/:appId/trains', deviceOrExternalRateLimit, async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  if (!Number.isInteger(appId) || appId <= 0) {
    res.status(400).json({ error: 'appId must be a positive integer' });
    return;
  }

  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  const device = deviceId ? getDevice(deviceId) : undefined;
  if (deviceId && (!device || !device.enabled)) {
    res.status(400).json({ error: 'deviceId must refer to an enabled device' });
    return;
  }

  try {
    const trains = await listTrains(appId, device);
    res.json({ trains });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/testflight/diagnostics', canManageSchedulerSettings, deviceOrExternalRateLimit, async (_req, res) => {
  try {
    res.json(await getTestFlightBridgeDiagnostics());
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/testflight/:appId/builds', deviceOrExternalRateLimit, async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  const trainVersion = typeof req.query.trainVersion === 'string' ? req.query.trainVersion : '';
  if (!Number.isInteger(appId) || appId <= 0 || !trainVersion) {
    res.status(400).json({ error: 'appId (positive integer) and trainVersion are required' });
    return;
  }

  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  const device = deviceId ? getDevice(deviceId) : undefined;
  if (deviceId && (!device || !device.enabled)) {
    res.status(400).json({ error: 'deviceId must refer to an enabled device' });
    return;
  }

  try {
    const builds = await listBuilds(appId, trainVersion, device);
    res.json({ builds });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.post('/v1/dashboard/testflight/decrypt', canDecrypt, blockDuringMaintenance, async (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'body', { requireActive: true });
  if (!projectId) return;
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const rawAppId = req.body?.appId;
  const appId = Number.parseInt(typeof rawAppId === 'string' || typeof rawAppId === 'number' ? String(rawAppId) : '', 10);
  const rawBuild = req.body?.build;
  const build = rawBuild && typeof rawBuild === 'object' ? rawBuild as Record<string, unknown> : undefined;
  if (!BUNDLE_ID_RE.test(bundleId) || !Number.isInteger(appId) || appId <= 0 || !build || typeof build.bundleId !== 'string') {
    res.status(400).json({ error: 'bundleId, appId, and build are required' });
    return;
  }
  if (build.bundleId !== bundleId) {
    res.status(400).json({ error: 'build.bundleId does not match bundleId' });
    return;
  }

  const requestedDeviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  const requestedDevice = requestedDeviceId ? getDevice(requestedDeviceId) : undefined;
  if (requestedDeviceId && (!requestedDevice || !requestedDevice.enabled)) {
    res.status(400).json({ error: 'deviceId must refer to an enabled device' });
    return;
  }
  let verifiedTestFlightApp;
  try {
    verifiedTestFlightApp = (await getVerifiedTestFlightCatalog({ requireAllDevices: true })).find((entry) => entry.appId === appId && entry.bundleId === bundleId);
  } catch (error) {
    if (error instanceof TestFlightCatalogUnavailableError) {
      res.status(503).json({ error: error.message, code: 'testflight_catalog_unavailable' });
      return;
    }
    throw error;
  }
  if (!verifiedTestFlightApp) {
    res.status(409).json({ error: 'TestFlight access must be verified on an enabled device before queueing' });
    return;
  }
  if (requestedDevice && verifiedTestFlightApp && !verifiedTestFlightApp.devices.some((device) => device.id === requestedDevice.id)) {
    res.status(409).json({ error: 'TestFlight access is not verified on the selected device' });
    return;
  }
  const preferPrimary = req.body?.preferPrimary === true;
  const preferredDeviceId = requestedDevice?.id
    ?? (verifiedTestFlightApp
      ? (preferPrimary && verifiedTestFlightApp.devices.some((device) => device.id === getPrimaryDevice()?.id)
        ? getPrimaryDevice()?.id
        : verifiedTestFlightApp.devices[0]?.id)
      : (preferPrimary ? getPrimaryDevice()?.id : undefined));

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    undefined,
    { appId, build: build as unknown as TFBuild },
    undefined,
    res.locals.session.sub,
    getUserPriority(res.locals.session.sub),
    preferredDeviceId,
    undefined,
    projectId,
  );
  res.status(202).json(jobSummary(job));
});

dashboardRouter.post('/v1/dashboard/jobs/:id/cancel', canDecrypt, (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  const ok = cancelJob(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(409).json({ error: 'job is not queued or running (already finished, or not found)' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/jobs/:id/prioritize', canDecrypt, (req, res) => {
  const job = getJob(req.params.id);
  if (!job || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, job.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  const ok = prioritizeQueuedJob(req.params.id, job.projectId ?? DEFAULT_PROJECT_ID);
  if (!ok) {
    res.status(409).json({ error: 'job is not queued (already running, finished, or not found)' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/jobs/reorder', canDecrypt, (req, res) => {
  const projectId = resolveRequestProjectId(req, res, 'body');
  if (!projectId) return;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const scopedJobs = ids.every((id) => {
    const job = getJob(id);
    return job && (job.projectId ?? DEFAULT_PROJECT_ID) === projectId;
  });
  const ok = scopedJobs && reorderQueue(ids, projectId);
  res.json({ ok });
});

dashboardRouter.post('/v1/dashboard/jobs/:id/retry', canDecrypt, blockDuringMaintenance, (req, res) => {
  const entry = getJobHistoryEntryById(req.params.id);
  if (!entry || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, entry.projectId ?? DEFAULT_PROJECT_ID)) {
    res.status(404).json({ error: 'job history entry not found' });
    return;
  }
  if (getProject(entry.projectId ?? DEFAULT_PROJECT_ID)?.archivedAt !== undefined) {
    res.status(409).json({ error: 'project is archived' });
    return;
  }

  const preferPrimary = req.body?.preferPrimary === true;
  const preferredDeviceId = preferPrimary ? getPrimaryDevice()?.id : undefined;
  const job = enqueueDecryptJob(
    entry.bundleId,
    'manual',
    entry.externalVersionId,
    entry.testflight,
    entry.versionLabel,
    res.locals.session.sub,
    getUserPriority(res.locals.session.sub),
    preferredDeviceId,
    undefined,
    entry.projectId ?? DEFAULT_PROJECT_ID,
  );
  res.status(202).json(jobSummary(job));
});

dashboardRouter.get('/v1/dashboard/jobs/:id/diagnostic', canDecrypt, (req, res) => {
  const active = getJob(req.params.id);
  const entry = active ? undefined : getJobHistoryEntryById(req.params.id);
  const projectId = active?.projectId ?? entry?.projectId ?? DEFAULT_PROJECT_ID;
  if ((!active && !entry) || !canAccessProject(res.locals.session.sub, res.locals.session.permissions, projectId)) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  const job = active ?? entry;
  if (!job) return;
  res.setHeader('Content-Disposition', `attachment; filename="dkrypt-job-${job.id}-diagnostic.json"`);
  res.json({ generatedAt: new Date().toISOString(), correlationId: job.correlationId ?? job.id, job, timeline: active?.timeline ?? entry?.timeline ?? [] });
});

dashboardRouter.get('/v1/dashboard/keys/mine', canViewOwnApiKeys, (_req, res) => {
  const { sub } = res.locals.session;
  res.json({ keys: listApiKeysForOwner(sub) });
});

const EXPIRY_OPTIONS = new Set([1, 7, 30, 90]);
const MAX_SCOPED_BUNDLE_IDS = 25;
const MIN_DAILY_LIMIT = 1;
const MAX_DAILY_LIMIT = 10_000;

function parseDailyLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(Math.round(value), MIN_DAILY_LIMIT), MAX_DAILY_LIMIT);
}

function parseAllowedBundleIds(body: unknown): string[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const ids = body
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => BUNDLE_ID_RE.test(v))
    .slice(0, MAX_SCOPED_BUNDLE_IDS);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

dashboardRouter.post('/v1/dashboard/keys/request', canRequestApiKeys, (req, res) => {
  const { sub } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const expiresInDays = typeof req.body?.expiresInDays === 'number' && EXPIRY_OPTIONS.has(req.body.expiresInDays)
    ? req.body.expiresInDays
    : undefined;
  const allowedBundleIds = parseAllowedBundleIds(req.body?.allowedBundleIds);
  const dailyLimit = parseDailyLimit(req.body?.dailyLimit);
  const allowTestFlight = typeof req.body?.allowTestFlight === 'boolean' ? req.body.allowTestFlight : undefined;

  const record = requestApiKey(name, sub, expiresInDays, allowedBundleIds, dailyLimit, allowTestFlight);
  void notify('keyRequest', {
    title: 'New API key request',
    description: `**${sub}** requested a new key ("${name}") - approve it on the API Keys tab.`,
    color: EMBED_COLOR.info,
  });
  res.status(201).json(record);
});

dashboardRouter.post('/v1/dashboard/keys/create', canAccessApi, (req, res) => {
  const { sub } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  const expiresInDays = typeof req.body?.expiresInDays === 'number' && EXPIRY_OPTIONS.has(req.body.expiresInDays)
    ? req.body.expiresInDays
    : undefined;
  const allowedBundleIds = parseAllowedBundleIds(req.body?.allowedBundleIds);
  const dailyLimit = parseDailyLimit(req.body?.dailyLimit);
  const allowTestFlight = typeof req.body?.allowTestFlight === 'boolean' ? req.body.allowTestFlight : undefined;
  res.status(201).json(createApiKey(name, sub, expiresInDays, allowedBundleIds, dailyLimit, allowTestFlight));
});

dashboardRouter.post('/v1/dashboard/keys/:id/reveal', canManageOrUseApiKeys, (req, res) => {
  const { sub } = res.locals.session;
  const secret = revealApiKeySecret(req.params.id, sub);
  if (!secret) {
    res.status(404).json({ error: 'no unrevealed secret for that key' });
    return;
  }
  res.json({ key: secret });
});

dashboardRouter.post('/v1/dashboard/keys/:id/regenerate', canManageOrUseApiKeys, (req, res) => {
  const { sub } = res.locals.session;
  const graceMinutesRaw = req.body?.graceMinutes;
  const graceMinutes = typeof graceMinutesRaw === 'number' && Number.isFinite(graceMinutesRaw) && graceMinutesRaw > 0 ? graceMinutesRaw : 0;
  const ok = regenerateApiKey(req.params.id, sub, graceMinutes);
  if (!ok) {
    res.status(404).json({ error: 'key not found, not yours, or not yet approved' });
    return;
  }
  res.json({ ok: true, key: getApiKeyById(req.params.id) });
});

dashboardRouter.delete('/v1/dashboard/keys/:id', canManageOrUseApiKeys, (req, res) => {
  const { sub, permissions } = res.locals.session;
  const ok = revokeApiKey(req.params.id, sub, hasPermission(permissions, PermissionFlag.manageApiKeys));
  if (!ok) {
    res.status(404).json({ error: 'key not found or not yours' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-revoke', canRevokeOwnedOrAnyApiKeys, (req, res) => {
  const { sub, permissions } = res.locals.session;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const canRevokeAny = hasPermission(permissions, PermissionFlag.manageApiKeys);
  const revoked = ids.filter((id: string) => revokeApiKey(id, sub, canRevokeAny));
  res.json({ revoked });
});

const MIN_EXPIRY_EXTEND_DAYS = 1;
const MAX_EXPIRY_EXTEND_DAYS = 3650;

dashboardRouter.post('/v1/dashboard/keys/bulk-extend-expiry', canManageApiKeyExpiry, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const days = typeof req.body?.days === 'number' ? Math.round(req.body.days) : undefined;
  if (!days || days < MIN_EXPIRY_EXTEND_DAYS || days > MAX_EXPIRY_EXTEND_DAYS) {
    res.status(400).json({ error: `days must be between ${MIN_EXPIRY_EXTEND_DAYS} and ${MAX_EXPIRY_EXTEND_DAYS}` });
    return;
  }
  const extended = bulkExtendApiKeyExpiry(ids, days);
  res.json({ extended });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-set-daily-limit', canManageApiKeyDailyLimits, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const raw = req.body?.dailyLimit;
  const dailyLimit = raw === null ? undefined : parseDailyLimit(raw);
  if (raw !== null && dailyLimit === undefined) {
    res.status(400).json({ error: 'dailyLimit must be a number, or null to clear it' });
    return;
  }
  const updated = bulkSetApiKeyDailyLimit(ids, dailyLimit);
  res.json({ updated });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-set-scope', canManageApiKeyDailyLimits, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const raw = req.body?.allowedBundleIds;
  if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
    res.status(400).json({ error: 'allowedBundleIds must be an array of bundle ids, or null to clear it' });
    return;
  }
  const allowedBundleIds = raw === null || raw === undefined ? undefined : parseAllowedBundleIds(raw);
  const updated = bulkSetApiKeyAllowedBundleIds(ids, allowedBundleIds);
  res.json({ updated });
});

dashboardRouter.get('/v1/dashboard/keys/:id/usage', requirePermission(PermissionFlag.createApiKeys, PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys), (req, res) => {
  const key = getApiKeyById(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  const { sub, permissions } = res.locals.session;
  if (key.ownerId !== sub && !hasPermission(permissions, PermissionFlag.viewApiKeys) && !hasPermission(permissions, PermissionFlag.manageApiKeys)) {
    res.status(403).json({ error: "not your key" });
    return;
  }
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
  res.json({ usage: getApiKeyUsage(req.params.id, days) });
});

dashboardRouter.get('/v1/dashboard/keys/:id/bundle-usage', requirePermission(PermissionFlag.createApiKeys, PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys), (req, res) => {
  const key = getApiKeyById(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  const { sub, permissions } = res.locals.session;
  if (key.ownerId !== sub && !hasPermission(permissions, PermissionFlag.viewApiKeys) && !hasPermission(permissions, PermissionFlag.manageApiKeys)) {
    res.status(403).json({ error: "not your key" });
    return;
  }
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 50);
  res.json({ bundles: getApiKeyBundleUsage(req.params.id, limit) });
});

dashboardRouter.get('/v1/dashboard/keys/:id/outcomes', requirePermission(PermissionFlag.createApiKeys, PermissionFlag.viewApiKeys, PermissionFlag.manageApiKeys), (req, res) => {
  const key = getApiKeyById(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  const { sub, permissions } = res.locals.session;
  if (key.ownerId !== sub && !hasPermission(permissions, PermissionFlag.viewApiKeys) && !hasPermission(permissions, PermissionFlag.manageApiKeys)) {
    res.status(403).json({ error: "not your key" });
    return;
  }
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 30);
  res.json({ outcomes: getApiKeyOutcomeUsage(req.params.id, limit) });
});

dashboardRouter.get('/v1/dashboard/keys/pending', canApproveApiKeys, (_req, res) => {
  res.json({ keys: listPendingApiKeys() });
});

dashboardRouter.get('/v1/dashboard/keys/all', canViewApiKeys, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
  const offset = typeof req.query.cursor === 'string' ? decodeCursor(req.query.cursor) : Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const page = listAllApiKeysPage(offset, limit, search);
  res.json({ ...page, nextCursor: nextCursor(offset, page.keys.length, page.total) });
});

dashboardRouter.post('/v1/dashboard/keys/:id/approve', canApproveApiKeys, (req, res) => {
  const ok = approveApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-approve', canApproveApiKeys, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const approved = bulkApproveApiKeys(ids);
  res.json({ approved });
});

dashboardRouter.patch('/v1/dashboard/keys/:id/priority', canManageApiKeyPriority, (req, res) => {
  const priority = typeof req.body?.priority === 'number' ? req.body.priority : undefined;
  if (priority === undefined || !Number.isFinite(priority)) {
    res.status(400).json({ error: 'priority (a number) is required' });
    return;
  }
  const updated = setApiKeyPriority(req.params.id, priority);
  if (!updated) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  res.json({ ok: true, priority: updated.priority });
});

dashboardRouter.patch('/v1/dashboard/keys/:id/max-concurrent', canManageApiKeyConcurrency, (req, res) => {
  const raw = req.body?.maxConcurrent;
  const maxConcurrent = raw === null || raw === undefined ? undefined : Number(raw);
  if (maxConcurrent !== undefined && (!Number.isFinite(maxConcurrent) || maxConcurrent <= 0)) {
    res.status(400).json({ error: 'maxConcurrent must be a positive number, or null to clear it' });
    return;
  }
  const updated = setApiKeyMaxConcurrent(req.params.id, maxConcurrent);
  if (!updated) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  res.json({ ok: true, maxConcurrent: updated.maxConcurrent });
});

dashboardRouter.patch('/v1/dashboard/keys/:id/allow-testflight', canManageApiKeyTestFlight, (req, res) => {
  const allowTestFlight = req.body?.allowTestFlight;
  if (typeof allowTestFlight !== 'boolean') {
    res.status(400).json({ error: 'allowTestFlight (boolean) is required' });
    return;
  }
  const updated = setApiKeyAllowTestFlight(req.params.id, allowTestFlight);
  if (!updated) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  res.json({ ok: true, allowTestFlight: updated.allowTestFlight ?? true });
});

dashboardRouter.post('/v1/dashboard/keys/:id/deny', canApproveApiKeys, (req, res) => {
  const ok = denyApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/users', canViewUsers, (_req, res) => {
  const assignments = new Map(listAllowedUsers().map((user) => [user.username, user]));
  const activity = getUserActivityStats();
  const users = listAuthProfiles().map((profile) => {
    const assignment = assignments.get(profile.userId);
    return {
      username: profile.userId,
      displayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      roleIds: assignment?.roleIds ?? [],
      addedAt: assignment?.addedAt ?? Date.parse(profile.updatedAt),
      lastActiveAt: assignment?.lastActiveAt,
      priority: assignment?.priority,
      activity: activity.get(profile.userId.toLowerCase()),
    };
  });
  for (const assignment of assignments.values()) {
    if (!users.some((user) => user.username === assignment.username)) {
      users.push({
        username: assignment.username,
        displayName: assignment.username,
        avatarUrl: '',
        roleIds: assignment.roleIds,
        addedAt: assignment.addedAt,
        lastActiveAt: assignment.lastActiveAt,
        priority: assignment.priority,
        activity: activity.get(assignment.username.toLowerCase()),
      });
    }
  }
  res.json({ users });
});

const AUDIT_LOG_CSV_COLUMNS = ['id', 'ts', 'actor', 'action', 'target', 'detail'] as const;

dashboardRouter.get('/v1/dashboard/audit-log/export', canViewUsers, (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const entries = getAuditLog(200);

  if (format === 'json') {
    res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-audit-log.json"');
    res.json(entries);
    return;
  }

  const rows = [AUDIT_LOG_CSV_COLUMNS.join(',')];
  for (const e of entries) {
    rows.push(AUDIT_LOG_CSV_COLUMNS.map((c) => csvCell(e[c])).join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-audit-log.csv"');
  res.send(rows.join('\n'));
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

dashboardRouter.post('/v1/dashboard/users', canManageUsers, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const roleIds = parseRoleIds(req.body?.roleIds);
  if (!username || !roleIds) {
    res.status(400).json({ error: 'username and roleIds (an array of role ids) are required' });
    return;
  }
  const targetBits = effectiveBitsForRoleIds(roleIds, listRoles());
  if (!canGrantBits(res.locals.session.permissions, targetBits)) {
    res.status(403).json({ error: "you can't grant permissions you don't have yourself" });
    return;
  }
  res.status(201).json(addAllowedUser(username, roleIds, res.locals.session.sub));
});

dashboardRouter.patch('/v1/dashboard/users/:username', canManageUsers, (req, res) => {
  const roleIds = parseRoleIds(req.body?.roleIds);
  if (!roleIds) {
    res.status(400).json({ error: 'roleIds (an array of role ids) is required' });
    return;
  }
  const targetBits = effectiveBitsForRoleIds(roleIds, listRoles());
  if (!canGrantBits(res.locals.session.permissions, targetBits)) {
    res.status(403).json({ error: "you can't grant permissions you don't have yourself" });
    return;
  }
  if (
    req.params.username.toLowerCase() === res.locals.session.sub.toLowerCase() &&
    !hasPermission(targetBits, PermissionFlag.manageUsers)
  ) {
    res.status(400).json({ error: "you can't remove your own ability to manage users" });
    return;
  }
  if (wouldOrphanPermission(req.params.username, PermissionFlag.manageUsers, roleIds)) {
    res.status(400).json({ error: 'this would leave nobody on the allowlist able to manage users - grant it to someone else first' });
    return;
  }
  const updated = updateAllowedUserRoles(req.params.username, roleIds, res.locals.session.sub);
  if (!updated) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  if (typeof req.body?.priority === 'number' && Number.isFinite(req.body.priority)) {
    setUserPriority(req.params.username, req.body.priority, res.locals.session.sub);
  }
  res.json(updated);
});

dashboardRouter.delete('/v1/dashboard/users/:username', canManageUsers, (req, res) => {
  if (wouldOrphanPermission(req.params.username, PermissionFlag.manageUsers, null)) {
    res.status(400).json({ error: 'this would leave nobody on the allowlist able to manage users - grant it to someone else first' });
    return;
  }
  const ok = removeAllowedUser(req.params.username, res.locals.session.sub);
  if (!ok) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  res.json({ ok: true });
});
