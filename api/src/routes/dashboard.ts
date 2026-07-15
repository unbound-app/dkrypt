import { Router } from 'express';
import {
  cancelAppleAuth,
  getAppleAuthStatus,
  isAppleAuthRunning,
  sendAppleAuthInput,
  startAppleReauth,
} from '../appleAuthRunner.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { enqueueDecryptJob, getActiveJobs, getJob } from '../jobs/store.js';
import { getRecentLogs } from '../logger.js';
import { applySchedule } from '../scheduler/index.js';
import { searchApps } from '../scheduler/itunes.js';
import { requireAdmin, requireSession } from '../session.js';
import {
  addAllowedUser,
  approveApiKey,
  clearAppleAuthAlert,
  createApiKey,
  denyApiKey,
  getAppleAuthAlert,
  getEffectiveSettings,
  getJobHistory,
  isSchedulerEnabled,
  listAllApiKeys,
  listAllowedUsers,
  listApiKeysForOwner,
  listPendingApiKeys,
  regenerateApiKey,
  removeAllowedUser,
  requestApiKey,
  revealApiKeySecret,
  revokeApiKey,
  updateSettings,
} from '../store/state.js';

export const dashboardRouter = Router();

dashboardRouter.use(requireSession);

// --- overview / jobs: read-only for everyone logged in ---

dashboardRouter.get('/v1/dashboard/overview', (_req, res) => {
  res.json({
    schedulerEnabled: isSchedulerEnabled(),
    settings: getEffectiveSettings(),
    appleAuthAlert: getAppleAuthAlert(),
    activeJobs: getActiveJobs().map((j) => ({
      id: j.id,
      bundleId: j.bundleId,
      source: j.source,
      status: j.status,
      progress: j.progress,
      createdAt: j.createdAt,
    })),
  });
});

dashboardRouter.get('/v1/dashboard/jobs', (_req, res) => {
  res.json({ history: getJobHistory() });
});

dashboardRouter.get('/v1/dashboard/logs', (_req, res) => {
  res.json({ logs: getRecentLogs() });
});

// --- decrypt-from-the-dashboard: open to every role, since it can't be
// automated (unlike settings/keys) - it's just a nice-to-have. Shares the
// exact same queue as the API/scheduler, so a dashboard-queued job can
// still get bumped behind a scheduler job that arrives after it. ---

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

dashboardRouter.post('/v1/dashboard/decrypt', (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId is required and must look like a bundle identifier' });
    return;
  }

  const job = enqueueDecryptJob(bundleId, 'manual');
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

// --- api keys: everyone manages their own; admins manage everyone's ---

dashboardRouter.get('/v1/dashboard/keys/mine', (_req, res) => {
  const { sub } = res.locals.session;
  res.json({ keys: listApiKeysForOwner(sub) });
});

/**
 * Admins get their key instantly (they're already fully trusted - there's
 * no one else to approve it); everyone else lands as 'pending' until an
 * admin approves it on this same tab.
 */
dashboardRouter.post('/v1/dashboard/keys/request', (req, res) => {
  const { sub, role } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }

  if (role === 'admin') {
    res.status(201).json(createApiKey(name, sub));
    return;
  }

  res.status(201).json(requestApiKey(name, sub));
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
  const ok = revokeApiKey(req.params.id, sub, role === 'admin');
  if (!ok) {
    res.status(404).json({ error: 'key not found or not yours' });
    return;
  }
  res.json({ ok: true });
});

// --- admin-only: approve/deny/create/list-all keys ---

dashboardRouter.get('/v1/dashboard/keys/pending', requireAdmin, (_req, res) => {
  res.json({ keys: listPendingApiKeys() });
});

dashboardRouter.get('/v1/dashboard/keys/all', requireAdmin, (_req, res) => {
  res.json({ keys: listAllApiKeys() });
});

dashboardRouter.post('/v1/dashboard/keys/:id/approve', requireAdmin, (req, res) => {
  const ok = approveApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

dashboardRouter.post('/v1/dashboard/keys/:id/deny', requireAdmin, (req, res) => {
  const ok = denyApiKey(req.params.id);
  if (!ok) {
    res.status(404).json({ error: 'no pending request with that id' });
    return;
  }
  res.json({ ok: true });
});

// --- admin-only: scheduler settings ---

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

  const updated = updateSettings(patch);
  applySchedule();
  res.json(updated);
});

dashboardRouter.post('/v1/dashboard/auth-alert/clear', requireAdmin, (_req, res) => {
  clearAppleAuthAlert();
  res.json({ ok: true });
});

// --- admin-only: user allowlist ---

dashboardRouter.get('/v1/dashboard/users', requireAdmin, (_req, res) => {
  res.json({ users: listAllowedUsers() });
});

dashboardRouter.post('/v1/dashboard/users', requireAdmin, (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const role = req.body?.role === 'admin' ? 'admin' : req.body?.role === 'member' ? 'member' : undefined;
  if (!username || !role) {
    res.status(400).json({ error: 'username and role (admin|member) are required' });
    return;
  }
  res.status(201).json(addAllowedUser(username, role));
});

dashboardRouter.delete('/v1/dashboard/users/:username', requireAdmin, (req, res) => {
  const ok = removeAllowedUser(req.params.username);
  if (!ok) {
    res.status(404).json({ error: 'not on the allowlist' });
    return;
  }
  res.json({ ok: true });
});

// --- admin-only: apple re-authentication bridge ---

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
