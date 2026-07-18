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
import { dashboardEvents, emitJobsChanged, getOnlineUsernames, registerPresence, unregisterPresence } from '../events.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { cancelJob, enqueueDecryptJob, getActiveJobs, getJob, prioritizeQueuedJob } from '../jobs/store.js';
import type { LogEntry } from '../logger.js';
import { getRecentLogs } from '../logger.js';
import { EMBED_COLOR, notify, sendTestNotification } from '../notify.js';
import { getVapidPublicKey, sendPushToUser } from '../push.js';
import { applyWatchSchedules, checkForTestFlightUpdate, checkForUpdate, triggerTickNow } from '../scheduler/index.js';
import { searchApps } from '../scheduler/itunes.js';
import { requirePermission, requireSession } from '../session.js';
import { getDeviceHealth } from '../deviceHealth.js';
import { validateDeviceRootDir } from '../idevice.js';
import { listBuilds, listTrains } from '../testflight.js';
import { nextCronRunAt } from '../util/cron.js';
import { getDiskUsage } from '../util/diskUsage.js';
import { buildSignedFileUrlWithToken } from '../util/signedUrl.js';
import { listAppVersions } from '../versions.js';
import {
  addAllowedUser,
  addPushSubscription,
  approveApiKey,
  type AppWatch,
  bulkApproveApiKeys,
  bulkExtendApiKeyExpiry,
  bulkSetApiKeyDailyLimit,
  clearAppleAuthAlert,
  createApiKey,
  createDevice,
  createWatch,
  deleteDevice,
  deleteWatch,
  denyApiKey,
  type DeviceRecord,
  exportBackup,
  getAllJobHistory,
  getApiKeyById,
  getApiKeyBundleUsage,
  getApiKeyUsage,
  getAppleAuthAlert,
  getAuditLog,
  getAverageJobDurationMs,
  getBundleStats,
  getDailyVolume,
  getDevice,
  getDeviceBatteryHourlyBuckets,
  getDeviceHealthHourlyBuckets,
  getDeviceStorageHourlyBuckets,
  getDeviceTemperatureHourlyBuckets,
  getDeviceUptimePercent,
  getEffectiveDevices,
  getEffectiveSettings,
  getEffectiveWatches,
  getInsightsSummary,
  getJobHistoryEntryById,
  getJobHistoryPage,
  getLastSchedulerRunAt,
  getPrimaryDevice,
  getSchedulerRunHistory,
  getUserPrefs,
  getUserPriority,
  getWatch,
  getWatchConfigIssues,
  getWebhookDeliveryLog,
  importBackup,
  isWatchSchedulable,
  type JobHistoryEntry,
  listAllApiKeysPage,
  listAllowedUsers,
  listApiKeysForOwner,
  listPendingApiKeys,
  listShareLinksForJob,
  PERMISSION_KEYS,
  type Permissions,
  recordShareLink,
  recordUserActivity,
  regenerateApiKey,
  removeAllowedUser,
  removePushSubscription,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  revokeShareLink,
  type SchedulerSettings,
  setApiKeyPriority,
  setUserPriority,
  updateAllowedUserPermissions,
  updateDevice,
  updateSettings,
  updateUserPrefs,
  updateWatch,
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
  const watches = getEffectiveWatches().map((w) => ({
    ...w,
    nextRunAt: isWatchSchedulable(w) ? nextCronRunAt(w.pollCron) : undefined,
    schedulable: isWatchSchedulable(w),
    configIssues: getWatchConfigIssues(w),
  }));
  const devices = getEffectiveDevices().map((d) => ({ ...d }));
  const settings = getEffectiveSettings();
  return {
    schedulerEnabled: watches.some((w) => w.schedulable),
    settings,
    watches,
    devices,
    appleAuthAlert: getAppleAuthAlert(),
    lastSchedulerRunAt: getLastSchedulerRunAt(),
    schedulerRunHistory: getSchedulerRunHistory(10),
    disk: getDiskUsage(config.outputDir),
    activeJobs: getActiveJobs().map((j) => ({
      id: j.id,
      bundleId: j.bundleId,
      source: j.source,
      status: j.status,
      progress: j.progress,
      versionLabel: j.versionLabel,
      deviceId: j.deviceId,
      testflight: j.testflight
        ? { appId: j.testflight.appId, buildId: j.testflight.build.id, version: j.testflight.build.cfBundleShortVersion, buildNumber: j.testflight.build.cfBundleVersion }
        : undefined,
      queuedBy: j.queuedBy,
      priority: j.priority,
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

  const { sub } = res.locals.session;
  registerPresence(sub);
  sendEvent('presence', getOnlineUsernames());

  const onJobsChanged = () => sendEvent('overview', buildOverview());
  const onLogAdded = (entry: LogEntry) => sendEvent('log', entry);
  const onHistoryAdded = (entry: JobHistoryEntry) => sendEvent('history', entry);
  const onAppleAuthChanged = () => sendEvent('appleAuth', getAppleAuthStatus());
  const onPresenceChanged = (usernames: string[]) => sendEvent('presence', usernames);

  dashboardEvents.on('jobsChanged', onJobsChanged);
  if (res.locals.session.permissions.viewLogs) dashboardEvents.on('logAdded', onLogAdded);
  dashboardEvents.on('historyAdded', onHistoryAdded);
  dashboardEvents.on('presenceChanged', onPresenceChanged);
  if (res.locals.session.permissions.manageAppleAuth) {
    sendEvent('appleAuth', getAppleAuthStatus());
    dashboardEvents.on('appleAuthChanged', onAppleAuthChanged);
  }

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unregisterPresence(sub);
    dashboardEvents.off('jobsChanged', onJobsChanged);
    dashboardEvents.off('logAdded', onLogAdded);
    dashboardEvents.off('historyAdded', onHistoryAdded);
    dashboardEvents.off('presenceChanged', onPresenceChanged);
    dashboardEvents.off('appleAuthChanged', onAppleAuthChanged);
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

// Shallow key-by-key diff of two historical decrypts of the same bundle - built from the
// Info.plist fields captured at decrypt time (Part 7), so no re-download/re-parse needed here.
dashboardRouter.get('/v1/dashboard/jobs/diff', (req, res) => {
  const bundleId = typeof req.query.bundleId === 'string' ? req.query.bundleId : '';
  const aId = typeof req.query.a === 'string' ? req.query.a : '';
  const bId = typeof req.query.b === 'string' ? req.query.b : '';
  const a = getJobHistoryEntryById(aId);
  const b = getJobHistoryEntryById(bId);
  if (!a || !b) {
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
  const topAppsLimit = Math.min(Math.max(Number.parseInt(String(req.query.topApps ?? '5'), 10) || 5, 1), 25);
  const trendDays = Math.min(Math.max(Number.parseInt(String(req.query.trendDays ?? '14'), 10) || 14, 1), 90);
  res.json(getInsightsSummary(topAppsLimit, trendDays));
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

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    externalVersionId,
    undefined,
    versionLabel,
    res.locals.session.sub,
    getUserPriority(res.locals.session.sub),
  );
  res.status(202).json(jobSummary(job));
});

dashboardRouter.get('/v1/dashboard/versions/:bundleId', async (req, res) => {
  const bundleId = req.params.bundleId;
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId must look like a bundle identifier' });
    return;
  }

  try {
    const versions = await listAppVersions(bundleId, req.query.force === 'true');
    res.json({ versions });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

function serializeDevice(d: DeviceRecord) {
  return d;
}

dashboardRouter.get('/v1/dashboard/devices', canManageScheduler, (_req, res) => {
  res.json({ devices: getEffectiveDevices().map(serializeDevice) });
});

interface DeviceInput {
  name: string;
  rootDir: string;
  enabled?: boolean;
  isPrimary?: boolean;
}

function parseDeviceInput(body: unknown): DeviceInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const rootDir = typeof b.rootDir === 'string' ? b.rootDir.trim() : '';
  if (!name || !rootDir) return undefined;
  return {
    name,
    rootDir,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
    isPrimary: typeof b.isPrimary === 'boolean' ? b.isPrimary : undefined,
  };
}

dashboardRouter.post('/v1/dashboard/devices', canManageScheduler, async (req, res) => {
  const input = parseDeviceInput(req.body);
  if (!input) {
    res.status(400).json({ error: 'name and rootDir are required' });
    return;
  }
  try {
    await validateDeviceRootDir(input.rootDir);
  } catch (err) {
    res.status(400).json({ error: `couldn't read a valid ipadecrypt config at that root dir: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  const device = createDevice(input, res.locals.session.sub);
  emitJobsChanged();
  res.status(201).json(device);
});

dashboardRouter.patch('/v1/dashboard/devices/:id', canManageScheduler, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<DeviceInput> = {};
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
  if (typeof body.rootDir === 'string' && body.rootDir.trim()) patch.rootDir = body.rootDir.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.isPrimary === 'boolean') patch.isPrimary = body.isPrimary;

  if (patch.rootDir) {
    try {
      await validateDeviceRootDir(patch.rootDir);
    } catch (err) {
      res.status(400).json({ error: `couldn't read a valid ipadecrypt config at that root dir: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }

  const result = updateDevice(req.params.id, patch, res.locals.session.sub);
  if (!result.ok) {
    res.status(404).json({ error: result.error });
    return;
  }
  emitJobsChanged();
  res.json(result.device);
});

dashboardRouter.delete('/v1/dashboard/devices/:id', canManageScheduler, (req, res) => {
  const ok = deleteDevice(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(404).json({ error: 'device not found' });
    return;
  }
  emitJobsChanged();
  res.json({ ok: true });
});

function requireDevice(id: string): DeviceRecord | undefined {
  return getDevice(id) ?? (id === 'primary' ? getPrimaryDevice() : undefined);
}

dashboardRouter.get('/v1/dashboard/devices/:id/health', async (req, res) => {
  const device = requireDevice(req.params.id);
  if (!device) {
    res.status(404).json({ error: 'device not found' });
    return;
  }
  const health = await getDeviceHealth(device.id, req.query.force === 'true');
  res.json(health);
});

dashboardRouter.get('/v1/dashboard/devices/:id/health-history', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  res.json({ buckets: getDeviceHealthHourlyBuckets(req.params.id, hours), uptimePercent: getDeviceUptimePercent(req.params.id, hours) ?? null });
});

dashboardRouter.get('/v1/dashboard/devices/:id/battery-history', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  res.json({ buckets: getDeviceBatteryHourlyBuckets(req.params.id, hours) });
});

dashboardRouter.get('/v1/dashboard/devices/:id/temperature-history', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  res.json({ buckets: getDeviceTemperatureHourlyBuckets(req.params.id, hours) });
});

dashboardRouter.get('/v1/dashboard/devices/:id/storage-history', (req, res) => {
  const hours = Math.min(Math.max(Number.parseInt(String(req.query.hours ?? '24'), 10) || 24, 1), 168);
  res.json({ buckets: getDeviceStorageHourlyBuckets(req.params.id, hours) });
});

function serializeWatch(w: AppWatch) {
  return { ...w, schedulable: isWatchSchedulable(w), configIssues: getWatchConfigIssues(w) };
}

dashboardRouter.get('/v1/dashboard/watches', canManageScheduler, (_req, res) => {
  res.json({ watches: getEffectiveWatches().map(serializeWatch) });
});

interface WatchInput {
  name?: string;
  bundleId: string;
  appRepo: string;
  ghDispatchRepo: string;
  ghWorkflowFile: string;
  pollCron: string;
  enabled?: boolean;
}

function parseWatchInput(body: unknown): WatchInput | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const b = body as Record<string, unknown>;
  const bundleId = typeof b.bundleId === 'string' ? b.bundleId.trim() : '';
  if (!bundleId) return undefined;
  return {
    name: typeof b.name === 'string' ? b.name.trim() || undefined : undefined,
    bundleId,
    appRepo: typeof b.appRepo === 'string' ? b.appRepo.trim() : '',
    ghDispatchRepo: typeof b.ghDispatchRepo === 'string' ? b.ghDispatchRepo.trim() : '',
    ghWorkflowFile: typeof b.ghWorkflowFile === 'string' ? b.ghWorkflowFile.trim() : 'remote-ipa-update.yml',
    pollCron: typeof b.pollCron === 'string' ? b.pollCron.trim() : '0 * * * *',
    enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
  };
}

dashboardRouter.post('/v1/dashboard/watches', canManageScheduler, (req, res) => {
  const input = parseWatchInput(req.body);
  if (!input) {
    res.status(400).json({ error: 'bundleId is required' });
    return;
  }
  if (input.pollCron && !validateCronExpr(input.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
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

dashboardRouter.patch('/v1/dashboard/watches/:id', canManageScheduler, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: Partial<WatchInput> = {};
  if (typeof body.name === 'string') patch.name = body.name.trim() || undefined;
  if (typeof body.bundleId === 'string' && body.bundleId.trim()) patch.bundleId = body.bundleId.trim();
  if (typeof body.appRepo === 'string') patch.appRepo = body.appRepo.trim();
  if (typeof body.ghDispatchRepo === 'string') patch.ghDispatchRepo = body.ghDispatchRepo.trim();
  if (typeof body.ghWorkflowFile === 'string') patch.ghWorkflowFile = body.ghWorkflowFile.trim();
  if (typeof body.pollCron === 'string') patch.pollCron = body.pollCron.trim();
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;

  if (patch.pollCron && !validateCronExpr(patch.pollCron)) {
    res.status(400).json({ error: 'pollCron is not a valid cron expression' });
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

dashboardRouter.delete('/v1/dashboard/watches/:id', canManageScheduler, (req, res) => {
  const ok = deleteWatch(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  applyWatchSchedules();
  emitJobsChanged();
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/watches/:id/preview-dispatch', canTriggerDispatch, async (req, res) => {
  const watch = getWatch(req.params.id);
  if (!watch) {
    res.status(404).json({ error: 'watch not found' });
    return;
  }
  const [appStore, testflight] = await Promise.all([checkForUpdate(watch), checkForTestFlightUpdate(watch)]);
  res.json({ ...appStore, testflight });
});

dashboardRouter.post('/v1/dashboard/watches/:id/trigger-dispatch', canTriggerDispatch, async (req, res) => {
  const result = await triggerTickNow(req.params.id);
  res.status(result.ok ? 202 : 409).json(result);
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

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    undefined,
    { appId, build },
    undefined,
    res.locals.session.sub,
    getUserPriority(res.locals.session.sub),
  );
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
  const ok = cancelJob(req.params.id, res.locals.session.sub);
  if (!ok) {
    res.status(409).json({ error: 'job is not queued or running (already finished, or not found)' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/jobs/:id/prioritize', canDecrypt, (req, res) => {
  const ok = prioritizeQueuedJob(req.params.id);
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

  const { url, token, expiresAtMs } = buildSignedFileUrlWithToken(job.id, ttlMinutes);
  recordShareLink(job.id, job.bundleId, token, res.locals.session.sub, expiresAtMs);
  res.json({ url, expiresAt: expiresAtMs });
});

dashboardRouter.get('/v1/dashboard/jobs/:id/share', (req, res) => {
  res.json({ links: listShareLinksForJob(req.params.id) });
});

dashboardRouter.post('/v1/dashboard/jobs/share/:linkId/revoke', (req, res) => {
  const ok = revokeShareLink(req.params.linkId);
  if (!ok) {
    res.status(404).json({ error: 'share link not found' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/keys/mine', (_req, res) => {
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
  const dailyLimit = parseDailyLimit(req.body?.dailyLimit);

  if (permissions.approveApiKeys) {
    res.status(201).json(createApiKey(name, sub, expiresInDays, allowedBundleIds, dailyLimit));
    return;
  }

  const record = requestApiKey(name, sub, expiresInDays, allowedBundleIds, dailyLimit);
  void notify('keyRequest', {
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

const MIN_EXPIRY_EXTEND_DAYS = 1;
const MAX_EXPIRY_EXTEND_DAYS = 3650;

dashboardRouter.post('/v1/dashboard/keys/bulk-extend-expiry', canApproveApiKeys, (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter((id: unknown) => typeof id === 'string') : [];
  const days = typeof req.body?.days === 'number' ? Math.round(req.body.days) : undefined;
  if (!days || days < MIN_EXPIRY_EXTEND_DAYS || days > MAX_EXPIRY_EXTEND_DAYS) {
    res.status(400).json({ error: `days must be between ${MIN_EXPIRY_EXTEND_DAYS} and ${MAX_EXPIRY_EXTEND_DAYS}` });
    return;
  }
  const extended = bulkExtendApiKeyExpiry(ids, days);
  res.json({ extended });
});

dashboardRouter.post('/v1/dashboard/keys/bulk-set-daily-limit', canApproveApiKeys, (req, res) => {
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

dashboardRouter.get('/v1/dashboard/keys/:id/bundle-usage', (req, res) => {
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
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '10'), 10) || 10, 1), 50);
  res.json({ bundles: getApiKeyBundleUsage(req.params.id, limit) });
});

dashboardRouter.get('/v1/dashboard/keys/pending', canApproveApiKeys, (_req, res) => {
  res.json({ keys: listPendingApiKeys() });
});

dashboardRouter.get('/v1/dashboard/keys/all', canViewApiKeys, (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
  const offset = Math.max(Number.parseInt(String(req.query.offset ?? '0'), 10) || 0, 0);
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const { keys, total } = listAllApiKeysPage(offset, limit, search);
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

dashboardRouter.patch('/v1/dashboard/keys/:id/priority', canApproveApiKeys, (req, res) => {
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

const SETTINGS_STRING_FIELDS = ['notifyWebhookUrl', 'jobWebhookUrl'] as const;
const SETTINGS_BOOL_FIELDS = [
  'notifyOnKeyRequest',
  'notifyOnDispatchSuccess',
  'notifyOnDispatchFailure',
  'notifyOnAppleAuthAlert',
  'notifyOnKeyExpiringSoon',
  'notifyOnDeviceOffline',
  'notifyOnDeviceBatteryHot',
  'notifyOnDeviceBatteryLow',
  'notifyOnDiskFull',
  'notifyOnDeviceStorageLow',
  'notifyOnTestFlightBridgeDown',
  'jobWebhookEnabled',
] as const;
const MAX_SCHEDULER_RETRY_COUNT = 5;
const MIN_DEVICE_OFFLINE_ALERT_MINUTES = 5;
const MAX_DEVICE_OFFLINE_ALERT_MINUTES = 180;
const MIN_BATTERY_HOT_ALERT_C = 30;
const MAX_BATTERY_HOT_ALERT_C = 60;
const MIN_BATTERY_LOW_ALERT_PERCENT = 5;
const MAX_BATTERY_LOW_ALERT_PERCENT = 50;
const MIN_DISK_FULL_ALERT_PERCENT = 50;
const MAX_DISK_FULL_ALERT_PERCENT = 99;
const MIN_DEVICE_STORAGE_ALERT_PERCENT = 50;
const MAX_DEVICE_STORAGE_ALERT_PERCENT = 99;
const MIN_TESTFLIGHT_BRIDGE_ALERT_MINUTES = 5;
const MAX_TESTFLIGHT_BRIDGE_ALERT_MINUTES = 180;
const MAX_JOB_HISTORY_RETENTION_DAYS = 365;

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
  if (typeof body.schedulerRetryCount === 'number') {
    patch.schedulerRetryCount = Math.min(Math.max(Math.round(body.schedulerRetryCount), 0), MAX_SCHEDULER_RETRY_COUNT);
  }
  if (typeof body.deviceOfflineAlertMinutes === 'number') {
    patch.deviceOfflineAlertMinutes = Math.min(
      Math.max(Math.round(body.deviceOfflineAlertMinutes), MIN_DEVICE_OFFLINE_ALERT_MINUTES),
      MAX_DEVICE_OFFLINE_ALERT_MINUTES,
    );
  }
  if (typeof body.batteryHotAlertC === 'number') {
    patch.batteryHotAlertC = Math.min(Math.max(Math.round(body.batteryHotAlertC), MIN_BATTERY_HOT_ALERT_C), MAX_BATTERY_HOT_ALERT_C);
  }
  if (typeof body.batteryLowAlertPercent === 'number') {
    patch.batteryLowAlertPercent = Math.min(
      Math.max(Math.round(body.batteryLowAlertPercent), MIN_BATTERY_LOW_ALERT_PERCENT),
      MAX_BATTERY_LOW_ALERT_PERCENT,
    );
  }
  if (typeof body.diskFullAlertPercent === 'number') {
    patch.diskFullAlertPercent = Math.min(Math.max(Math.round(body.diskFullAlertPercent), MIN_DISK_FULL_ALERT_PERCENT), MAX_DISK_FULL_ALERT_PERCENT);
  }
  if (typeof body.deviceStorageAlertPercent === 'number') {
    patch.deviceStorageAlertPercent = Math.min(
      Math.max(Math.round(body.deviceStorageAlertPercent), MIN_DEVICE_STORAGE_ALERT_PERCENT),
      MAX_DEVICE_STORAGE_ALERT_PERCENT,
    );
  }
  if (typeof body.testFlightBridgeAlertMinutes === 'number') {
    patch.testFlightBridgeAlertMinutes = Math.min(
      Math.max(Math.round(body.testFlightBridgeAlertMinutes), MIN_TESTFLIGHT_BRIDGE_ALERT_MINUTES),
      MAX_TESTFLIGHT_BRIDGE_ALERT_MINUTES,
    );
  }
  if (typeof body.jobHistoryRetentionDays === 'number') {
    patch.jobHistoryRetentionDays = Math.min(Math.max(Math.round(body.jobHistoryRetentionDays), 0), MAX_JOB_HISTORY_RETENTION_DAYS);
  }

  const updated = updateSettings(patch, res.locals.session.sub);
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
  if (typeof req.body?.priority === 'number' && Number.isFinite(req.body.priority)) {
    setUserPriority(req.params.username, req.body.priority, res.locals.session.sub);
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
  applyWatchSchedules();
  emitJobsChanged();
  res.json({ ok: true });
});

dashboardRouter.get('/v1/dashboard/me/prefs', (_req, res) => {
  res.json(getUserPrefs(res.locals.session.sub));
});

dashboardRouter.get('/v1/dashboard/push/public-key', (_req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

function isPushSubscriptionShape(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Record<string, unknown>;
  if (typeof s.endpoint !== 'string') return false;
  const keys = s.keys as Record<string, unknown> | undefined;
  return typeof keys === 'object' && keys !== null && typeof keys.p256dh === 'string' && typeof keys.auth === 'string';
}

dashboardRouter.post('/v1/dashboard/push/subscribe', (req, res) => {
  if (!isPushSubscriptionShape(req.body)) {
    res.status(400).json({ error: 'a valid push subscription (endpoint, keys.p256dh, keys.auth) is required' });
    return;
  }
  addPushSubscription(res.locals.session.sub, { endpoint: req.body.endpoint, keys: req.body.keys });
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/push/unsubscribe', (req, res) => {
  const endpoint = typeof req.body?.endpoint === 'string' ? req.body.endpoint : '';
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint is required' });
    return;
  }
  removePushSubscription(res.locals.session.sub, endpoint);
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/push/test', async (_req, res) => {
  await sendPushToUser(res.locals.session.sub, {
    title: 'dkrypt',
    body: 'Push notifications are set up - you\'ll get one of these when your queued decrypts finish.',
  });
  res.json({ ok: true });
});

dashboardRouter.put('/v1/dashboard/me/prefs', (req, res) => {
  const body = req.body ?? {};
  const patch: { theme?: 'dark' | 'light' | 'auto'; density?: 'comfortable' | 'compact'; accent?: string } = {};
  if (body.theme === 'dark' || body.theme === 'light' || body.theme === 'auto') patch.theme = body.theme;
  if (body.density === 'comfortable' || body.density === 'compact') patch.density = body.density;
  if (typeof body.accent === 'string' && /^[a-z-]{1,32}$/.test(body.accent)) patch.accent = body.accent;
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
