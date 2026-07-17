import { Router } from 'express';
import { validate as validateCronExpr } from 'node-cron';
import { config } from '../config.js';
import {
  cancelAppleAuth,
  getAppleAuthStatus,
  isAppleAuthRunning,
  sendAppleAuthInput,
  startAppleReauth,
} from '../appleAuthRunner.js';
import { dashboardEvents } from '../events.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { cancelQueuedJob, enqueueDecryptJob, getActiveJobs, getJob } from '../jobs/store.js';
import type { LogEntry } from '../logger.js';
import { getRecentLogs } from '../logger.js';
import { EMBED_COLOR, notify, sendTestNotification } from '../notify.js';
import { applySchedule, checkForTestFlightUpdate, checkForUpdate, triggerTickNow } from '../scheduler/index.js';
import { searchApps } from '../scheduler/itunes.js';
import { requirePermission, requireSession } from '../session.js';
import { getDeviceHealth, listBuilds, listTrains } from '../testflight.js';
import { nextCronRunAt } from '../util/cron.js';
import { getDiskUsage } from '../util/diskUsage.js';
import { buildSignedFileUrl } from '../util/signedUrl.js';
import { listAppVersions } from '../versions.js';
import {
  addAllowedUser,
  approveApiKey,
  bulkApproveApiKeys,
  clearAppleAuthAlert,
  createApiKey,
  denyApiKey,
  exportBackup,
  getAllJobHistory,
  getApiKeyById,
  getApiKeyUsage,
  getAppleAuthAlert,
  getAuditLog,
  getAverageJobDurationMs,
  getBundleStats,
  getDailyVolume,
  getDeviceHealthHourlyBuckets,
  getDeviceUptimePercent,
  getEffectiveSettings,
  getJobHistoryPage,
  getLastSchedulerRunAt,
  getSchedulerConfigIssues,
  getSchedulerRunHistory,
  getUserPrefs,
  importBackup,
  isSchedulerEnabled,
  type JobHistoryEntry,
  listAllApiKeysPage,
  listAllowedUsers,
  listApiKeysForOwner,
  listPendingApiKeys,
  PERMISSION_KEYS,
  type Permissions,
  recordUserActivity,
  regenerateApiKey,
  removeAllowedUser,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  type SchedulerSettings,
  updateAllowedUserPermissions,
  updateSettings,
  updateUserPrefs,
  wouldOrphanManageUsers,
} from '../store/state.js';

const canDecrypt = requirePermission('decrypt');
const canViewApiKeys = requirePermission('viewApiKeys');
const canApproveApiKeys = requirePermission('approveApiKeys');
const canManageScheduler = requirePermission('manageScheduler');
const canTriggerDispatch = requirePermission('triggerDispatch');
const canManageAppleAuth = requirePermission('manageAppleAuth');
const canViewLogs = requirePermission('viewLogs');
const canViewUsers = requirePermission('viewUsers', 'manageUsers');
const canManageUsers = requirePermission('manageUsers');

export const dashboardRouter = Router();

dashboardRouter.use(requireSession);
dashboardRouter.use((_req, res, next) => {
  recordUserActivity(res.locals.session.sub);
  next();
});

function buildOverview() {
  const schedulerEnabled = isSchedulerEnabled();
  const settings = getEffectiveSettings();
  return {
    schedulerEnabled,
    settings,
    appleAuthAlert: getAppleAuthAlert(),
    lastSchedulerRunAt: getLastSchedulerRunAt(),
    nextSchedulerRunAt: schedulerEnabled ? nextCronRunAt(settings.pollCron) : undefined,
    schedulerRunHistory: getSchedulerRunHistory(10),
    configIssues: getSchedulerConfigIssues(),
    disk: getDiskUsage(config.outputDir),
    activeJobs: getActiveJobs().map((j) => ({
      id: j.id,
      bundleId: j.bundleId,
      source: j.source,
      status: j.status,
      progress: j.progress,
      versionLabel: j.versionLabel,
      testflight: j.testflight
        ? { appId: j.testflight.appId, buildId: j.testflight.build.id, version: j.testflight.build.cfBundleShortVersion, buildNumber: j.testflight.build.cfBundleVersion }
        : undefined,
      queuedBy: j.queuedBy,
      createdAt: j.createdAt,
    })),
  };
}

dashboardRouter.get('/v1/dashboard/overview', (_req, res) => {
  res.json(buildOverview());
});

dashboardRouter.get('/v1/dashboard/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('overview', buildOverview());

  const onJobsChanged = () => sendEvent('overview', buildOverview());
  const onLogAdded = (entry: LogEntry) => sendEvent('log', entry);
  const onHistoryAdded = (entry: JobHistoryEntry) => sendEvent('history', entry);

  dashboardEvents.on('jobsChanged', onJobsChanged);
  if (res.locals.session.permissions.viewLogs) dashboardEvents.on('logAdded', onLogAdded);
  dashboardEvents.on('historyAdded', onHistoryAdded);

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    dashboardEvents.off('jobsChanged', onJobsChanged);
    dashboardEvents.off('logAdded', onLogAdded);
    dashboardEvents.off('historyAdded', onHistoryAdded);
  });
});

dashboardRouter.get('/v1/dashboard/jobs', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '15'), 10) || 15, 1), 100);
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim().slice(0, 200) : undefined;
  const source = req.query.source === 'manual' || req.query.source === 'scheduler' ? req.query.source : undefined;
  const status = req.query.status === 'done' || req.query.status === 'failed' ? req.query.status : undefined;
  const { entries, total } = getJobHistoryPage(offset, limit, q, source, status);
  res.json({ history: entries, total });
});

dashboardRouter.get('/v1/dashboard/logs', canViewLogs, (_req, res) => {
  res.json({ logs: getRecentLogs() });
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
  'createdAt',
  'startedAt',
  'finishedAt',
] as const;

function csvCell(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

dashboardRouter.get('/v1/dashboard/jobs/export', (req, res) => {
  const format = req.query.format === 'csv' ? 'csv' : 'json';
  const entries = getAllJobHistory();

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
  res.json({ avgMs: getAverageJobDurationMs(req.params.bundleId) ?? null });
});

dashboardRouter.get('/v1/dashboard/jobs/stats/:bundleId', (req, res) => {
  res.json(getBundleStats(req.params.bundleId));
});

dashboardRouter.get('/v1/dashboard/jobs/volume', (req, res) => {
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
  res.json({ days: getDailyVolume(days) });
});

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

dashboardRouter.get('/v1/dashboard/search', async (req, res) => {
  const term = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!term || term.length > 200) {
    res.status(400).json({ error: 'query param q is required' });
    return;
  }

  try {
    const results = await searchApps(term);
    res.json({ results });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

dashboardRouter.post('/v1/dashboard/decrypt', canDecrypt, (req, res) => {
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

  const job = enqueueDecryptJob(bundleId, 'manual', externalVersionId, undefined, versionLabel, res.locals.session.sub);
  res.status(202).json(jobSummary(job));
});

dashboardRouter.get('/v1/dashboard/versions/:bundleId', async (req, res) => {
  const bundleId = req.params.bundleId;
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId must look like a bundle identifier' });
    return;
  }

  try {
    const versions = await listAppVersions(bundleId);
    res.json({ versions });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/device/health', async (_req, res) => {
  const health = await getDeviceHealth();
  res.json(health);
});

dashboardRouter.get('/v1/dashboard/device/health-history', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  res.json({ buckets: getDeviceHealthHourlyBuckets(hours), uptimePercent: getDeviceUptimePercent(hours) ?? null });
});

dashboardRouter.get('/v1/dashboard/testflight/:appId/trains', async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  if (!Number.isInteger(appId) || appId <= 0) {
    res.status(400).json({ error: 'appId must be a positive integer' });
    return;
  }

  try {
    const trains = await listTrains(appId);
    res.json({ trains });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.get('/v1/dashboard/testflight/:appId/builds', async (req, res) => {
  const appId = Number.parseInt(req.params.appId, 10);
  const trainVersion = typeof req.query.trainVersion === 'string' ? req.query.trainVersion : '';
  if (!Number.isInteger(appId) || appId <= 0 || !trainVersion) {
    res.status(400).json({ error: 'appId (positive integer) and trainVersion are required' });
    return;
  }

  try {
    const builds = await listBuilds(appId, trainVersion);
    res.json({ builds });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

dashboardRouter.post('/v1/dashboard/testflight/decrypt', canDecrypt, (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const appId = Number.parseInt(req.body?.appId, 10);
  const build = req.body?.build;
  if (!BUNDLE_ID_RE.test(bundleId) || !Number.isInteger(appId) || appId <= 0 || !build || typeof build !== 'object') {
    res.status(400).json({ error: 'bundleId, appId, and build are required' });
    return;
  }
  if (build.bundleId !== bundleId) {
    res.status(400).json({ error: 'build.bundleId does not match bundleId' });
    return;
  }

  const job = enqueueDecryptJob(bundleId, 'manual', undefined, { appId, build }, undefined, res.locals.session.sub);
  res.status(202).json(jobSummary(job));
});

dashboardRouter.get('/v1/dashboard/jobs/:id/status', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found (finished jobs are pruned after retention window)' });
    return;
  }
  res.json(jobSummary(job));
});

dashboardRouter.post('/v1/dashboard/jobs/:id/cancel', canDecrypt, (req, res) => {
  const ok = cancelQueuedJob(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(409).json({ error: 'job is not queued (already running, finished, or not found)' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/jobs/:id/file', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  await streamJobFile(job, req, res);
});

const SHARE_TTL_MIN = 1;
const SHARE_TTL_MAX = 1440;

dashboardRouter.post('/v1/dashboard/jobs/:id/share', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (job.status !== 'done' || !job.filePath) {
    res.status(409).json({ error: 'job is not finished yet' });
    return;
  }

  const requested = Number.parseInt(String(req.body?.ttlMinutes ?? config.fileTtlMinutes), 10);
  const ttlMinutes = Number.isFinite(requested) ? Math.min(Math.max(requested, SHARE_TTL_MIN), SHARE_TTL_MAX) : config.fileTtlMinutes;

  res.json({ url: buildSignedFileUrl(job.id, ttlMinutes), expiresAt: Date.now() + ttlMinutes * 60_000 });
});

dashboardRouter.get('/v1/dashboard/keys/mine', (_req, res) => {
  const { sub } = res.locals.session;
  res.json({ keys: listApiKeysForOwner(sub) });
});

const EXPIRY_OPTIONS = new Set([1, 7, 30, 90]);
const MAX_SCOPED_BUNDLE_IDS = 25;

function parseAllowedBundleIds(body: unknown): string[] | undefined {
  if (!Array.isArray(body)) return undefined;
  const ids = body
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.trim())
    .filter((v) => BUNDLE_ID_RE.test(v))
    .slice(0, MAX_SCOPED_BUNDLE_IDS);
  return ids.length > 0 ? [...new Set(ids)] : undefined;
}

dashboardRouter.post('/v1/dashboard/keys/request', canDecrypt, (req, res) => {
  const { sub, permissions } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const expiresInDays = typeof req.body?.expiresInDays === 'number' && EXPIRY_OPTIONS.has(req.body.expiresInDays)
    ? req.body.expiresInDays
    : undefined;
  const allowedBundleIds = parseAllowedBundleIds(req.body?.allowedBundleIds);

  if (permissions.approveApiKeys) {
    res.status(201).json(createApiKey(name, sub, expiresInDays, allowedBundleIds));
    return;
  }

  const record = requestApiKey(name, sub, expiresInDays, allowedBundleIds);
  void notify('keyRequest', '🔑 New API key request', {
    title: 'New API key request',
    description: `**${sub}** requested a new key ("${name}") - approve it on the API Keys tab.`,
    color: EMBED_COLOR.info,
  });
  res.status(201).json(record);
});

dashboardRouter.post('/v1/dashboard/keys/:id/reveal', (req, res) => {
  const { sub } = res.locals.session;
  const secret = revealApiKeySecret(req.params.id, sub);
  if (!secret) {
    res.status(404).json({ error: 'no unrevealed secret for that key' });
    return;
  }
  res.json({ key: secret });
});

dashboardRouter.post('/v1/dashboard/keys/:id/regenerate', (req, res) => {
  const { sub } = res.locals.session;
  const ok = regenerateApiKey(req.params.id, sub);
  if (!ok) {
    res.status(404).json({ error: 'key not found, not yours, or not yet approved' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.delete('/v1/dashboard/keys/:id', (req, res) => {
  const { sub, permissions } = res.locals.session;
  const ok = revokeApiKey(req.params.id, sub, permissions.revokeApiKeys);
  if (!ok) {
    res.status(404).json({ error: 'key not found or not yours' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-revoke', (req, res) => {
  const { sub, permissions } = res.locals.session;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const revoked = ids.filter((id: string) => revokeApiKey(id, sub, permissions.revokeApiKeys));
  res.json({ revoked });
});

dashboardRouter.get('/v1/dashboard/keys/:id/usage', (req, res) => {
  const key = getApiKeyById(req.params.id);
  if (!key) {
    res.status(404).json({ error: 'key not found' });
    return;
  }
  const { sub, permissions } = res.locals.session;
  if (key.ownerId !== sub && !permissions.viewApiKeys) {
    res.status(403).json({ error: "not your key" });
    return;
  }
  const days = Math.min(Math.max(Number.parseInt(String(req.query.days ?? '14'), 10) || 14, 1), 90);
  res.json({ usage: getApiKeyUsage(req.params.id, days) });
});

dashboardRouter.get('/v1/dashboard/keys/pending', canApproveApiKeys, (_req, res) => {
  res.json({ keys: listPendingApiKeys() });
});

dashboardRouter.get('/v1/dashboard/keys/all', canViewApiKeys, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  const { keys, total } = listAllApiKeysPage(offset, limit);
  res.json({ keys, total });
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

dashboardRouter.post('/v1/dashboard/keys/:id/deny', canApproveApiKeys, (req, res) => {
  const ok = denyApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/settings', (_req, res) => {
  res.json(getEffectiveSettings());
});

const SETTINGS_STRING_FIELDS = ['watchBundleId', 'watchAppRepo', 'ghDispatchRepo', 'ghWorkflowFile', 'pollCron', 'notifyWebhookUrl'] as const;
const SETTINGS_BOOL_FIELDS = ['notifyOnKeyRequest', 'notifyOnDispatchSuccess', 'notifyOnDispatchFailure', 'notifyOnAppleAuthAlert'] as const;

dashboardRouter.put('/v1/dashboard/settings', canManageScheduler, (req, res) => {
  const body = req.body ?? {};
  const patch: Partial<SchedulerSettings> = {};

  for (const field of SETTINGS_STRING_FIELDS) {
    if (typeof body[field] === 'string') patch[field] = body[field].trim();
  }
  for (const field of SETTINGS_BOOL_FIELDS) {
    if (typeof body[field] === 'boolean') patch[field] = body[field];
  }
  if (body.notifyFormat === 'embed' || body.notifyFormat === 'plain') {
    patch.notifyFormat = body.notifyFormat;
  }

  if (typeof patch.pollCron === 'string' && patch.pollCron !== '' && !validateCronExpr(patch.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
    return;
  }

  const updated = updateSettings(patch);
  applySchedule();
  res.json(updated);
});

dashboardRouter.get('/v1/dashboard/settings/validate-cron', canManageScheduler, (req, res) => {
  const expr = typeof req.query.expr === 'string' ? req.query.expr : '';
  res.json({ valid: expr !== '' && validateCronExpr(expr) });
});

dashboardRouter.post('/v1/dashboard/settings/test-webhook', canTriggerDispatch, async (req, res) => {
  const url = typeof req.body?.url === 'string' && req.body.url.trim() ? req.body.url.trim() : undefined;
  const result = await sendTestNotification(url);
  res.status(result.ok ? 200 : 400).json(result);
});

dashboardRouter.get('/v1/dashboard/settings/preview-dispatch', canTriggerDispatch, async (_req, res) => {
  const settings = getEffectiveSettings();
  const [appStore, testflight] = await Promise.all([checkForUpdate(settings), checkForTestFlightUpdate(settings)]);
  res.json({ ...appStore, testflight });
});

dashboardRouter.post('/v1/dashboard/settings/trigger-dispatch', canTriggerDispatch, async (_req, res) => {
  const result = await triggerTickNow();
  res.status(result.ok ? 202 : 409).json(result);
});

dashboardRouter.post('/v1/dashboard/auth-alert/clear', canTriggerDispatch, (_req, res) => {
  clearAppleAuthAlert();
  res.json({ ok: true });
});

function parsePermissions(body: unknown): Permissions | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  if (!PERMISSION_KEYS.every((k) => typeof b[k] === 'boolean')) return undefined;
  return Object.fromEntries(PERMISSION_KEYS.map((k) => [k, b[k] as boolean])) as unknown as Permissions;
}

dashboardRouter.get('/v1/dashboard/users', canViewUsers, (_req, res) => {
  res.json({ users: listAllowedUsers() });
});

dashboardRouter.get('/v1/dashboard/audit-log', canViewUsers, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 200);
  res.json({ entries: getAuditLog(limit) });
});

dashboardRouter.post('/v1/dashboard/users', canManageUsers, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const permissions = parsePermissions(req.body?.permissions);
  if (!username || !permissions) {
    res.status(400).json({ error: `username and permissions (${PERMISSION_KEYS.join(', ')}) are required` });
    return;
  }
  res.status(201).json(addAllowedUser(username, permissions, res.locals.session.sub));
});

dashboardRouter.patch('/v1/dashboard/users/:username', canManageUsers, (req, res) => {
  const permissions = parsePermissions(req.body?.permissions);
  if (!permissions) {
    res.status(400).json({ error: `permissions (${PERMISSION_KEYS.join(', ')}) are required` });
    return;
  }
  if (req.params.username.toLowerCase() === res.locals.session.sub.toLowerCase() && !permissions.manageUsers) {
    res.status(400).json({ error: "you can't remove your own ability to manage users" });
    return;
  }
  if (wouldOrphanManageUsers(req.params.username, permissions)) {
    res.status(400).json({ error: 'this would leave nobody on the allowlist able to manage users - grant it to someone else first' });
    return;
  }
  const updated = updateAllowedUserPermissions(req.params.username, permissions, res.locals.session.sub);
  if (!updated) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  res.json(updated);
});

dashboardRouter.delete('/v1/dashboard/users/:username', canManageUsers, (req, res) => {
  if (wouldOrphanManageUsers(req.params.username, null)) {
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

dashboardRouter.get('/v1/dashboard/backup/export', canManageUsers, (_req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="dkrypt-backup.json"');
  res.json(exportBackup());
});

dashboardRouter.post('/v1/dashboard/backup/import', canManageUsers, (req, res) => {
  const result = importBackup(req.body, res.locals.session.sub);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  applySchedule();
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/me/prefs', (_req, res) => {
  res.json(getUserPrefs(res.locals.session.sub));
});

dashboardRouter.put('/v1/dashboard/me/prefs', (req, res) => {
  const body = req.body ?? {};
  const patch: { theme?: 'dark' | 'light'; density?: 'comfortable' | 'compact' } = {};
  if (body.theme === 'dark' || body.theme === 'light') patch.theme = body.theme;
  if (body.density === 'comfortable' || body.density === 'compact') patch.density = body.density;
  res.json(updateUserPrefs(res.locals.session.sub, patch));
});

dashboardRouter.get('/v1/dashboard/apple-auth/status', canManageAppleAuth, (_req, res) => {
  res.json(getAppleAuthStatus());
});

dashboardRouter.post('/v1/dashboard/apple-auth/start', canManageAppleAuth, (_req, res) => {
  if (isAppleAuthRunning()) {
    res.status(409).json({ error: 'already running' });
    return;
  }
  try {
    startAppleReauth();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

dashboardRouter.post('/v1/dashboard/apple-auth/input', canManageAppleAuth, (req, res) => {
  const value = typeof req.body?.value === 'string' ? req.body.value : '';
  try {
    sendAppleAuthInput(value);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});

dashboardRouter.post('/v1/dashboard/apple-auth/cancel', canManageAppleAuth, (_req, res) => {
  cancelAppleAuth();
  res.json({ ok: true });
});
