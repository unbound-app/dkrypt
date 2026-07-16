import { Router } from 'express';
import { validate as validateCronExpr } from 'node-cron';
import {
  cancelAppleAuth,
  getAppleAuthStatus,
  isAppleAuthRunning,
  sendAppleAuthInput,
  startAppleReauth,
} from '../appleAuthRunner.js';
import { dashboardEvents } from '../events.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { enqueueDecryptJob, getActiveJobs, getJob } from '../jobs/store.js';
import type { LogEntry } from '../logger.js';
import { getRecentLogs } from '../logger.js';
import { sendTestNotification } from '../notify.js';
import { applySchedule, checkForTestFlightUpdate, checkForUpdate } from '../scheduler/index.js';
import { searchApps } from '../scheduler/itunes.js';
import { requireAdmin, requireRole, requireSession } from '../session.js';
import { getDeviceHealth, listBuilds, listTrains } from '../testflight.js';
import { listAppVersions } from '../versions.js';
import {
  addAllowedUser,
  approveApiKey,
  clearAppleAuthAlert,
  createApiKey,
  denyApiKey,
  getAppleAuthAlert,
  getAverageJobDurationMs,
  getDailyVolume,
  getEffectiveSettings,
  getJobHistoryPage,
  getLastSchedulerRunAt,
  getUserPrefs,
  isSchedulerEnabled,
  type JobHistoryEntry,
  listAllApiKeys,
  listAllowedUsers,
  listApiKeysForOwner,
  listPendingApiKeys,
  regenerateApiKey,
  type Role,
  removeAllowedUser,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  updateAllowedUserRole,
  updateSettings,
  updateUserPrefs,
} from '../store/state.js';

const ROLES: Role[] = ['admin', 'operator', 'member', 'viewer'];
const canManageKeys = requireRole('admin', 'operator');
const canDecrypt = requireRole('admin', 'operator', 'member');

export const dashboardRouter = Router();

dashboardRouter.use(requireSession);

function buildOverview() {
  return {
    schedulerEnabled: isSchedulerEnabled(),
    settings: getEffectiveSettings(),
    appleAuthAlert: getAppleAuthAlert(),
    lastSchedulerRunAt: getLastSchedulerRunAt(),
    activeJobs: getActiveJobs().map((j) => ({
      id: j.id,
      bundleId: j.bundleId,
      source: j.source,
      status: j.status,
      progress: j.progress,
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
  dashboardEvents.on('logAdded', onLogAdded);
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
  const { entries, total } = getJobHistoryPage(offset, limit);
  res.json({ history: entries, total });
});

dashboardRouter.get('/v1/dashboard/logs', (_req, res) => {
  res.json({ logs: getRecentLogs() });
});

dashboardRouter.get('/v1/dashboard/jobs/eta/:bundleId', (req, res) => {
  res.json({ avgMs: getAverageJobDurationMs(req.params.bundleId) ?? null });
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

  const job = enqueueDecryptJob(bundleId, 'manual', externalVersionId);
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

  const job = enqueueDecryptJob(bundleId, 'manual', undefined, { appId, build });
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

dashboardRouter.get('/v1/dashboard/jobs/:id/file', async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  await streamJobFile(job, req, res);
});

dashboardRouter.get('/v1/dashboard/keys/mine', (_req, res) => {
  const { sub } = res.locals.session;
  res.json({ keys: listApiKeysForOwner(sub) });
});

const EXPIRY_OPTIONS = new Set([1, 7, 30, 90]);

dashboardRouter.post('/v1/dashboard/keys/request', canDecrypt, (req, res) => {
  const { sub, role } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  const expiresInDays = typeof req.body?.expiresInDays === 'number' && EXPIRY_OPTIONS.has(req.body.expiresInDays)
    ? req.body.expiresInDays
    : undefined;

  if (role === 'admin' || role === 'operator') {
    res.status(201).json(createApiKey(name, sub, expiresInDays));
    return;
  }

  res.status(201).json(requestApiKey(name, sub, expiresInDays));
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
  const { sub, role } = res.locals.session;
  const ok = revokeApiKey(req.params.id, sub, role === 'admin' || role === 'operator');
  if (!ok) {
    res.status(404).json({ error: 'key not found or not yours' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-revoke', (req, res) => {
  const { sub, role } = res.locals.session;
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const revoked = ids.filter((id: string) => revokeApiKey(id, sub, role === 'admin' || role === 'operator'));
  res.json({ revoked });
});

dashboardRouter.get('/v1/dashboard/keys/pending', canManageKeys, (_req, res) => {
  res.json({ keys: listPendingApiKeys() });
});

dashboardRouter.get('/v1/dashboard/keys/all', canManageKeys, (_req, res) => {
  res.json({ keys: listAllApiKeys() });
});

dashboardRouter.post('/v1/dashboard/keys/:id/approve', canManageKeys, (req, res) => {
  const ok = approveApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/:id/deny', canManageKeys, (req, res) => {
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

const SETTINGS_FIELDS = ['watchBundleId', 'watchAppRepo', 'ghDispatchRepo', 'ghWorkflowFile', 'pollCron', 'notifyWebhookUrl'] as const;

dashboardRouter.put('/v1/dashboard/settings', requireAdmin, (req, res) => {
  const body = req.body ?? {};
  const patch: Record<string, string> = {};

  for (const field of SETTINGS_FIELDS) {
    if (typeof body[field] === 'string') patch[field] = body[field].trim();
  }

  if (typeof patch.pollCron === 'string' && patch.pollCron !== '' && !validateCronExpr(patch.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
    return;
  }

  const updated = updateSettings(patch);
  applySchedule();
  res.json(updated);
});

dashboardRouter.get('/v1/dashboard/settings/validate-cron', requireAdmin, (req, res) => {
  const expr = typeof req.query.expr === 'string' ? req.query.expr : '';
  res.json({ valid: expr !== '' && validateCronExpr(expr) });
});

dashboardRouter.post('/v1/dashboard/settings/test-webhook', requireAdmin, async (_req, res) => {
  const result = await sendTestNotification();
  res.status(result.ok ? 200 : 400).json(result);
});

dashboardRouter.get('/v1/dashboard/settings/preview-dispatch', requireAdmin, async (_req, res) => {
  const settings = getEffectiveSettings();
  const [appStore, testflight] = await Promise.all([checkForUpdate(settings), checkForTestFlightUpdate(settings)]);
  res.json({ ...appStore, testflight });
});

dashboardRouter.post('/v1/dashboard/auth-alert/clear', requireAdmin, (_req, res) => {
  clearAppleAuthAlert();
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/users', requireAdmin, (_req, res) => {
  res.json({ users: listAllowedUsers() });
});

dashboardRouter.post('/v1/dashboard/users', requireAdmin, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const role = ROLES.includes(req.body?.role) ? (req.body.role as Role) : undefined;
  if (!username || !role) {
    res.status(400).json({ error: `username and role (${ROLES.join('|')}) are required` });
    return;
  }
  res.status(201).json(addAllowedUser(username, role));
});

dashboardRouter.patch('/v1/dashboard/users/:username', requireAdmin, (req, res) => {
  const role = ROLES.includes(req.body?.role) ? (req.body.role as Role) : undefined;
  if (!role) {
    res.status(400).json({ error: `role (${ROLES.join('|')}) is required` });
    return;
  }
  if (req.params.username.toLowerCase() === res.locals.session.sub.toLowerCase() && role !== 'admin') {
    res.status(400).json({ error: "you can't change your own role away from admin" });
    return;
  }
  const updated = updateAllowedUserRole(req.params.username, role);
  if (!updated) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  res.json(updated);
});

dashboardRouter.delete('/v1/dashboard/users/:username', requireAdmin, (req, res) => {
  const ok = removeAllowedUser(req.params.username);
  if (!ok) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/me/prefs', (_req, res) => {
  res.json(getUserPrefs(res.locals.session.sub));
});

dashboardRouter.put('/v1/dashboard/me/prefs', (req, res) => {
  const body = req.body ?? {};
  const patch: { theme?: 'dark' | 'light' } = {};
  if (body.theme === 'dark' || body.theme === 'light') patch.theme = body.theme;
  res.json(updateUserPrefs(res.locals.session.sub, patch));
});

dashboardRouter.get('/v1/dashboard/apple-auth/status', requireAdmin, (_req, res) => {
  res.json(getAppleAuthStatus());
});

dashboardRouter.post('/v1/dashboard/apple-auth/start', requireAdmin, (_req, res) => {
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

dashboardRouter.post('/v1/dashboard/apple-auth/input', requireAdmin, (req, res) => {
  const value = typeof req.body?.value === 'string' ? req.body.value : '';
  try {
    sendAppleAuthInput(value);
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: String(err) });
  }
});

dashboardRouter.post('/v1/dashboard/apple-auth/cancel', requireAdmin, (_req, res) => {
  cancelAppleAuth();
  res.json({ ok: true });
});
