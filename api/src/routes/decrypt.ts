import type { Response } from 'express';
import { Router } from 'express';
import { config } from '../config.js';
import { requireApiKey, requireApiKeyOrSignedToken } from '../auth.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '../jobs/store.js';
import { recordApiKeyBundleUsage } from '../store/state.js';
import { listBuilds, listTrains } from '../testflight.js';

export const decryptRouter = Router();

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isBundleIdAllowed(res: Response, bundleId: string): boolean {
  const scope = res.locals.apiKeyScope as string[] | undefined;
  return !scope || scope.length === 0 || scope.includes(bundleId);
}

decryptRouter.get('/v1/decrypt', requireApiKey, async (req, res) => {
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
  if (apiKeyId) recordApiKeyBundleUsage(apiKeyId, bundleId);

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    versionId,
    undefined,
    undefined,
    res.locals.apiKeyOwner as string | undefined,
    (res.locals.apiKeyPriority as number | undefined) ?? 0,
  );
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

decryptRouter.get('/v1/testflight/:appId/trains', requireApiKey, async (req, res) => {
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

decryptRouter.get('/v1/testflight/:appId/builds', requireApiKey, async (req, res) => {
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

decryptRouter.post('/v1/testflight/decrypt', requireApiKey, (req, res) => {
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
  if (apiKeyId) recordApiKeyBundleUsage(apiKeyId, bundleId);

  const job = enqueueDecryptJob(
    bundleId,
    'manual',
    undefined,
    { appId, build },
    undefined,
    res.locals.apiKeyOwner as string | undefined,
    (res.locals.apiKeyPriority as number | undefined) ?? 0,
  );
  res.status(202).json(jobSummary(job));
});
