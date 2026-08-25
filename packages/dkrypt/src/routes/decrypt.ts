import type { Request, Response } from '#http.js';
import { Router } from '#http.js';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { config } from '#config.js';
import { requireApiKey, requireApiKeyOrSignedToken, requireTestFlightScope } from '#auth.js';
import { blockDuringMaintenance } from '#maintenance.js';
import { jobFileAvailable, jobSummary, streamJobFile } from '#jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '#jobs/store.js';
import { recordApiKeyBundleUsage } from '#store/state.js';
import { listBuilds, listTrains } from '#testflight.js';
import { apiIdempotencyRegistry } from '#idempotency.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, listArtifacts, touchArtifact } from '#artifacts.js';
import { resolveDecryptTarget, VERSION_SELECTOR_RE } from '#decryptTarget.js';

export const decryptRouter = Router();

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function artifactSummary(artifact: ReturnType<typeof getArtifactById>) {
  if (!artifact) return undefined;
  return {
    id: artifact.id,
    bundleId: artifact.bundleId,
    channel: artifact.channel,
    externalVersionId: artifact.externalVersionId,
    testflightBuildId: artifact.testflightBuildId,
    versionLabel: artifact.versionLabel,
    buildNumber: artifact.buildNumber,
    sizeBytes: artifact.fileSizeBytes,
    sha256: artifact.sha256,
    createdAt: new Date(artifact.createdAt).toISOString(),
    lastAccessedAt: new Date(artifact.lastAccessedAt).toISOString(),
    accessCount: artifact.accessCount,
    fileUrl: `/v1/artifacts/${artifact.id}/file`,
  };
}

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

function apiRequester(res: Response): string {
  return (res.locals.apiKeyOwner as string | undefined) ?? 'api-key';
}

decryptRouter.post('/v1/decrypts', requireApiKey, blockDuringMaintenance, async (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const selector = typeof req.body?.version === 'string' ? req.body.version.trim() : undefined;
  if (!BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'bundleId is required and must look like a bundle identifier' });
    return;
  }
  if (selector && !VERSION_SELECTOR_RE.test(selector)) {
    res.status(400).json({ error: 'version must match a release tag such as 240, 234.2, or 240_109440' });
    return;
  }
  if (!isBundleIdAllowed(res, bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }

  try {
    const target = await resolveDecryptTarget(bundleId, selector);
    if (target.channel === 'testflight' && res.locals.apiKeyAllowTestFlight === false) {
      res.status(403).json({ error: 'this API key is not scoped for TestFlight' });
      return;
    }
    const apiKeyId = res.locals.apiKeyId as string | undefined;
    if (apiKeyId) recordApiKeyBundleUsage(apiKeyId, bundleId);
    const job = enqueueDecryptJob(
      bundleId,
      'manual',
      target.externalVersionId,
      target.testflight,
      target.versionLabel,
      apiRequester(res),
      (res.locals.apiKeyPriority as number | undefined) ?? 0,
      undefined,
      apiKeyId,
    );
    const payload = {
      ...jobSummary(job),
      selector: target.selector,
      channel: target.channel,
      resolvedVersion: target.versionLabel,
      cacheHit: job.cacheHit === true,
      artifact: job.artifactId ? artifactSummary(getArtifactById(job.artifactId)) : undefined,
    };
    res.status(job.status === 'done' ? 200 : 202).json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(message.includes('version') || message.includes('build') || message.includes('train') ? 404 : 502).json({ error: message });
  }
});

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
  const selector = typeof req.query.version === 'string' ? req.query.version.trim() : undefined;
  if (selector && !VERSION_SELECTOR_RE.test(selector)) {
    res.status(400).json({ error: 'version must match a release tag such as 240, 234.2, or 240_109440' });
    return;
  }

  const apiKeyId = res.locals.apiKeyId as string | undefined;
  const fingerprint = requestFingerprint('/v1/decrypt', { bundleId, externalVersionId: versionId ?? null, version: selector ?? null });
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
    if (selector) {
      try {
        const target = await resolveDecryptTarget(bundleId, selector);
        if (target.channel === 'testflight' && res.locals.apiKeyAllowTestFlight === false) {
          res.status(403).json({ error: 'this API key is not scoped for TestFlight' });
          return;
        }
        job = enqueueDecryptJob(
          bundleId,
          'manual',
          target.externalVersionId,
          target.testflight,
          target.versionLabel,
          apiRequester(res),
          (res.locals.apiKeyPriority as number | undefined) ?? 0,
          undefined,
          apiKeyId,
        );
      } catch (err) {
        res.status(404).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    } else {
      job = enqueueDecryptJob(
        bundleId,
        'manual',
        versionId,
        undefined,
        undefined,
        apiRequester(res),
        (res.locals.apiKeyPriority as number | undefined) ?? 0,
        undefined,
        apiKeyId,
      );
    }
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

decryptRouter.get('/v1/artifacts', requireApiKey, (req, res) => {
  const offset = Number.parseInt(String(req.query.offset ?? '0'), 10);
  const limit = Number.parseInt(String(req.query.limit ?? '50'), 10);
  const channel = req.query.channel === 'appstore' || req.query.channel === 'testflight' ? req.query.channel : undefined;
  const result = listArtifacts({
    offset: Number.isFinite(offset) ? offset : 0,
    limit: Number.isFinite(limit) ? limit : 50,
    query: typeof req.query.q === 'string' ? req.query.q : undefined,
    channel,
  });
  res.json({ ...result, artifacts: result.artifacts.map(artifactSummary) });
});

decryptRouter.get('/v1/artifacts/:id', requireApiKey, (req, res) => {
  const artifact = getArtifactById(req.params.id);
  if (!artifact || !artifactFileAvailable(artifact)) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  res.json(artifactSummary(artifact));
});

decryptRouter.get('/v1/artifacts/:id/file', requireApiKeyOrSignedToken, async (req, res) => {
  const artifact = getArtifactById(req.params.id);
  if (!artifact || !artifactFileAvailable(artifact)) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  await touchArtifact(artifact);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${artifactDownloadName(artifact)}"`);
  res.setHeader('Content-Length', String(artifact.fileSizeBytes));
  res.reply.send(createReadStream(artifact.filePath));
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
      apiRequester(res),
      (res.locals.apiKeyPriority as number | undefined) ?? 0,
      undefined,
      apiKeyId,
    );
    if (idempotency.key && apiKeyId) apiIdempotencyRegistry.record(apiKeyId, idempotency.key, fingerprint, job.id, IDEMPOTENCY_TTL_MS);
  }
  res.status(202).json(jobSummary(job));
});
