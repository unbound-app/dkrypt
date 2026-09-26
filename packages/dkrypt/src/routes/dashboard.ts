import { Router, type Request, type Response } from '#http.js';
import { projectIdentifierPattern } from '#apiCommonContracts.js';
import { config, discordBotEnabled } from '#config.js';
import { fetchBotGuilds, fetchGuildRoles } from '#discord.js';
import { dashboardEvents, getOnlineUsernames, nextDashboardSequence, registerDashboardConnection, registerPresence, unregisterPresence } from '#events.js';
import { blockDuringMaintenance } from '#maintenance.js';
import { jobSummary, streamFilePath } from '#jobs/http.js';
import { cancelJob, enqueueDecryptJob, getActiveJobs, getJob, getQueueInfo, prioritizeQueuedJob, reorderQueue } from '#jobs/store.js';
import type { LogEntry } from '#logger.js';
import { getRecentLogs } from '#logger.js';
import { hasPermission, isSubsetPermission, PermissionFlag } from '#permissions.js';
import { canGrantBits } from '#dashboardAdminRules.js';
import { lookupAppMetadata, searchApps } from '#scheduler/itunes.js';
import { requirePermission, requireSession } from '#session.js';
import { recordDashboardSessionActivity } from '#dashboardActivity.js';
import { canAccessProject, dashboardHistoryEntry } from '#dashboardJobPresentation.js';
import { buildDashboardOverview } from '#dashboardOverview.js';
import { getDeviceHealth, getDeviceInstallBlocker, getDeviceReadiness } from '#deviceHealth.js';
import { logBelongsToProject } from '#dashboardLogPresentation.js';
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
  createDiscordRolePerk,
  DEFAULT_PROJECT_ID,
  deleteDiscordRolePerk,
  effectiveBitsForRoleIds,
  getAllJobHistory,
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
  getJobHistoryEntryById,
  getPrimaryDevice,
  getSchedulerRunHistory,
  getStateDatabaseStatus,
  getWatchHealthRollup,
  getUserPriority,
  getWatchDispatchTargets,
  getWebhookDeliveryLog,
  getAppCatalogEntries,
  getAppCatalogStats,
  type JobHistoryEntry,
  listRoles,
  recordAudit,
  setDiscordGuilds,
  upsertAppCatalogEntries,
  verifyLatestDatabaseBackup,
} from '#store/state.js';

const canDecrypt = requirePermission(PermissionFlag.requestDecrypt);
const canManageStorage = requirePermission(PermissionFlag.manageAutomation);
const canViewScheduler = requirePermission(PermissionFlag.viewAutomation, PermissionFlag.manageAutomation);
const canManageWatches = requirePermission(PermissionFlag.manageAutomation);

const canViewLogs = requirePermission(PermissionFlag.viewLogs);
const canViewUsers = requirePermission(PermissionFlag.viewUsers, PermissionFlag.manageUsers);
const canViewDiscordPerks = requirePermission(PermissionFlag.viewRoles, PermissionFlag.manageRoles);
const canManageDiscordPerks = requirePermission(PermissionFlag.manageRoles);
export const dashboardRouter = Router();

dashboardRouter.use(requireSession);
dashboardRouter.use((_req, res, next) => {
  recordDashboardSessionActivity(res.locals.session);
  next();
});

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
