import type { Request, Response } from '#http.js';
import { Router } from '#http.js';
import { createHash } from 'node:crypto';
import { config } from '#config.js';
import { requireApiKey, requireApiKeyOrSignedToken, requireTestFlightScope } from '#auth.js';
import { blockDuringMaintenance } from '#maintenance.js';
import { jobFileAvailable, jobSummary, streamJobFile } from '#jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '#jobs/store.js';
import { recordApiKeyBundleUsage } from '#store/state.js';
import { listBuilds, listTrains } from '#testflight.js';
import { apiIdempotencyRegistry } from '#idempotency.js';

export const decryptRouter = Router();

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function idempotencyJobId(req: Request, res: Response, fingerprint: string): { jobId?: string; error?: string; key?: string } {
  const key = req.header('idempotency-key');
  if (!key) return {};
  if (!IDEMPOTENCY_KEY_RE.test(key)) return { error: 'Idempotency-Key must be 1-200 URL-safe characters' };
  const scope = res.locals.apiKeyId as string | undefined;
  if (!scope) return { error: 'API key identity is unavailable' };
  const existing = apiIdempotencyRegistry.lookup(scope, key, fingerprint);
  if (existing.conflict) return { error: 'Idempotency-Key was already used with a different request' };
  return { jobId: existing.jobId, key };
}

function requestFingerprint(route: string, body: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify({ route, body })).digest('hex');
}

function isBundleIdAllowed(res: Response, bundleId: string): boolean {
  const scope = res.locals.apiKeyScope as string[] | undefined;
  return !scope || scope.length === 0 || scope.includes(bundleId);
}

decryptRouter.get('/v1/decrypt', requireApiKey, blockDuringMaintenance, async (req, res) => {
  const bundleId = req.query.bundleId;
  if (typeof bundleId !== 'string' || !BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'query param bundleId is required and must look like a bundle identifier' });
    return;
  }

  if (!isBundleIdAllowed(res, bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }

  const externalVersionId = req.query.externalVersionId;
  const versionId =
    typeof externalVersionId === 'string' && EXTERNAL_VERSION_ID_RE.test(externalVersionId) ? externalVersionId : undefined;

  const apiKeyId = res.locals.apiKeyId as string | undefined;
  const fingerprint = requestFingerprint('/v1/decrypt', { bundleId, externalVersionId: versionId ?? null });
  const idempotency = idempotencyJobId(req, res, fingerprint);
  if (idempotency.error) {
    res.status(409).json({ error: idempotency.error });
    return;
  }

  let job = idempotency.jobId ? getJob(idempotency.jobId) : undefined;
  if (idempotency.jobId && !job) {
    res.status(410).json({ error: 'the result for this Idempotency-Key is no longer retained' });
    return;
  }
  if (!job) {
    if (apiKeyId) recordApiKeyBundleUsage(apiKeyId, bundleId);
    job = enqueueDecryptJob(
      bundleId,
      'manual',
      versionId,
      undefined,
      undefined,
      res.locals.apiKeyOwner as string | undefined,
      (res.locals.apiKeyPriority as number | undefined) ?? 0,
      undefined,
      apiKeyId,
    );
    if (idempotency.key && apiKeyId) apiIdempotencyRegistry.record(apiKeyId, idempotency.key, fingerprint, job.id, IDEMPOTENCY_TTL_MS);
  }
  if (job.status === 'done' && !jobFileAvailable(job)) {
    res.status(410).json({ error: 'the result for this Idempotency-Key is no longer retained' });
    return;
  }
  const finished = await waitForJob(job, config.jobMaxWaitSeconds * 1000);

  if (finished.status === 'queued' || finished.status === 'running') {
    res.status(202).json(jobSummary(finished));
    return;
  }

  if (finished.status === 'failed') {
    res.status(500).json(jobSummary(finished));
    return;
  }

  await streamJobFile(finished, req, res);
});

decryptRouter.get('/v1/jobs/:id', requireApiKey, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found (finished jobs are pruned after retention window)' });
    return;
  }
  if (!isBundleIdAllowed(res, job.bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }
  res.json(jobSummary(job));
});

decryptRouter.get('/v1/jobs/:id/file', requireApiKeyOrSignedToken, async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }
  if (!isBundleIdAllowed(res, job.bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }

  if (job.status !== 'done' || !job.filePath) {
    res.status(409).json(jobSummary(job));
    return;
  }

  await streamJobFile(job, req, res);
});

decryptRouter.get('/v1/testflight/:appId/trains', requireApiKey, requireTestFlightScope, async (req, res) => {
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

decryptRouter.get('/v1/testflight/:appId/builds', requireApiKey, requireTestFlightScope, async (req, res) => {
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

decryptRouter.post('/v1/testflight/decrypt', requireApiKey, requireTestFlightScope, blockDuringMaintenance, (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const appId = Number.parseInt(req.body?.appId, 10);
  const build = req.body?.build;

  if (!BUNDLE_ID_RE.test(bundleId) || !Number.isInteger(appId) || appId <= 0 || !build || typeof build !== 'object') {
    res.status(400).json({ error: 'bundleId, appId, and build are required' });
    return;
  }
  if (!isBundleIdAllowed(res, bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }
  if (build.bundleId !== bundleId) {
    res.status(400).json({ error: 'build.bundleId does not match bundleId' });
    return;
  }

  const apiKeyId = res.locals.apiKeyId as string | undefined;
  const fingerprint = requestFingerprint('/v1/testflight/decrypt', { bundleId, appId, build });
  const idempotency = idempotencyJobId(req, res, fingerprint);
  if (idempotency.error) {
    res.status(409).json({ error: idempotency.error });
    return;
  }

  let job = idempotency.jobId ? getJob(idempotency.jobId) : undefined;
  if (idempotency.jobId && !job) {
    res.status(410).json({ error: 'the result for this Idempotency-Key is no longer retained' });
    return;
  }
  if (!job) {
    if (apiKeyId) recordApiKeyBundleUsage(apiKeyId, bundleId);
    job = enqueueDecryptJob(
      bundleId,
      'manual',
      undefined,
      { appId, build },
      undefined,
      res.locals.apiKeyOwner as string | undefined,
      (res.locals.apiKeyPriority as number | undefined) ?? 0,
      undefined,
      apiKeyId,
    );
    if (idempotency.key && apiKeyId) apiIdempotencyRegistry.record(apiKeyId, idempotency.key, fingerprint, job.id, IDEMPOTENCY_TTL_MS);
  }
  res.status(202).json(jobSummary(job));
});
