import { Router } from 'express';
import {
  cancelAppleAuth,
  getAppleAuthStatus,
  isAppleAuthRunning,
  sendAppleAuthInput,
  startAppleReauth,
} from '../appleAuthRunner.js';
import { getActiveJobs } from '../jobs/store.js';
import { applySchedule } from '../scheduler/index.js';
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
    recentHistory: getJobHistory().slice(0, 10),
  });
});

dashboardRouter.get('/v1/dashboard/jobs', (_req, res) => {
  res.json({ history: getJobHistory() });
});

// --- api keys: everyone manages their own; admins manage everyone's ---

dashboardRouter.get('/v1/dashboard/keys/mine', (_req, res) => {
  const { sub } = res.locals.session;
  res.json({ keys: listApiKeysForOwner(sub) });
});

dashboardRouter.post('/v1/dashboard/keys/request', (req, res) => {
  const { sub } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
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

dashboardRouter.post('/v1/dashboard/keys', requireAdmin, (req, res) => {
  const { sub } = res.locals.session;
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  if (!name) {
    res.status(400).json({ error: 'name is required' });
    return;
  }
  res.status(201).json(createApiKey(name, sub));
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
