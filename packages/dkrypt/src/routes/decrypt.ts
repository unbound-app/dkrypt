import type { Request, Response } from '#http.js';
import { Router } from '#http.js';
import { createHash } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { config } from '#config.js';
import { fastifyRequireApiKey, fastifyRequireTestFlightScope, getFastifyApiKeyContext, requireApiKey, requireTestFlightScope } from '#auth.js';
import { blockDuringMaintenance } from '#maintenance.js';
import { jobFileAvailable, jobSummary, streamFilePath, streamJobFile } from '#jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '#jobs/store.js';
import { recordApiKeyBundleUsage } from '#store/state.js';
import { listBuilds, listTrains, type TFBuild } from '#testflight.js';
import { apiIdempotencyRegistry } from '#idempotency.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactById, listArtifacts, touchArtifact } from '#artifacts.js';
import { resolveDecryptTarget, VERSION_SELECTOR_RE } from '#decryptTarget.js';
import { decodeCursor, nextCursor } from '#util/cursor.js';
import { getRouteContract } from '#contracts.js';

export const decryptRouter = Router();
export const artifactAndJobRouter = Router();
export const testFlightDecryptRouter = Router();

interface TestFlightCatalogServices {
  listTrains: typeof listTrains;
  listBuilds: typeof listBuilds;
}

interface ArtifactCatalogServices {
  listArtifacts: typeof listArtifacts;
  getArtifactById: typeof getArtifactById;
  artifactFileAvailable: typeof artifactFileAvailable;
}

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

function isBundleIdAllowed(scope: string[] | undefined, bundleId: string): boolean {
  return !scope || scope.length === 0 || scope.includes(bundleId);
}

function normalizeBundleScope(scope: string[] | undefined): string[] | undefined {
  return scope && scope.length > 0 ? scope : undefined;
}

function apiRequester(res: Response): string {
  return (res.locals.apiKeyOwner as string | undefined) ?? 'api-key';
}

function apiErrorEnvelope(message: string, code: string, requestId: string, retryable = false) {
  return { error: message, code, message, requestId, retryable };
}

function testFlightLookupFailure(error: unknown, requestId: string) {
  const message = error instanceof Error ? error.message : String(error);
  return { error: message, code: 'testflight_lookup_failed', message, requestId, retryable: true };
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
  if (!isBundleIdAllowed(res.locals.apiKeyScope, bundleId)) {
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

  if (!isBundleIdAllowed(res.locals.apiKeyScope, bundleId)) {
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

artifactAndJobRouter.get('/v1/artifacts/:id/file', requireApiKey, async (req, res) => {
  const artifact = getArtifactById(req.params.id);
  if (!artifact || !artifactFileAvailable(artifact)) {
    res.status(404).json({ error: 'artifact not found' });
    return;
  }
  if (!isBundleIdAllowed(res.locals.apiKeyScope, artifact.bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }
  await touchArtifact(artifact);
  await streamFilePath(artifact.filePath, req, res, artifactDownloadName(artifact), artifact.fileSizeBytes, artifact.id);
});

artifactAndJobRouter.get('/v1/jobs/:id', requireApiKey, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found (finished jobs are pruned after retention window)' });
    return;
  }
  if (!isBundleIdAllowed(res.locals.apiKeyScope, job.bundleId)) {
    res.status(403).json({ error: 'this API key is not scoped to this bundleId' });
    return;
  }
  res.json(jobSummary(job));
});

testFlightDecryptRouter.post('/v1/testflight/decrypt', requireApiKey, requireTestFlightScope, blockDuringMaintenance, (req, res) => {
  const bundleId = typeof req.body?.bundleId === 'string' ? req.body.bundleId.trim() : '';
  const rawAppId = req.body?.appId;
  const appId = Number.parseInt(typeof rawAppId === 'string' || typeof rawAppId === 'number' ? String(rawAppId) : '', 10);
  const rawBuild = req.body?.build;
  const build = rawBuild && typeof rawBuild === 'object' ? rawBuild as Record<string, unknown> : undefined;

  if (!BUNDLE_ID_RE.test(bundleId) || !Number.isInteger(appId) || appId <= 0 || !build || typeof build.bundleId !== 'string') {
    res.status(400).json({ error: 'bundleId, appId, and build are required' });
    return;
  }
  if (!isBundleIdAllowed(res.locals.apiKeyScope, bundleId)) {
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
      { appId, build: build as unknown as TFBuild },
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

export function createArtifactCatalogRoutes(
  services: ArtifactCatalogServices = { listArtifacts, getArtifactById, artifactFileAvailable },
): FastifyPluginAsyncTypebox {
  return async (server) => {
    server.get(
      '/v1/artifacts',
      { schema: getRouteContract('GET', '/v1/artifacts'), preHandler: fastifyRequireApiKey },
      async (request) => {
        const query = request.query as {
          cursor?: string;
          offset?: string | number;
          limit?: string | number;
          q?: string;
          channel?: 'appstore' | 'testflight';
        };
        const offset = typeof query.cursor === 'string' ? decodeCursor(query.cursor) : Number.parseInt(String(query.offset ?? '0'), 10);
        const limit = Number.parseInt(String(query.limit ?? '50'), 10);
        const result = services.listArtifacts({
          offset: Number.isFinite(offset) ? offset : 0,
          limit: Number.isFinite(limit) ? limit : 50,
          query: query.q,
          channel: query.channel,
          bundleIds: normalizeBundleScope(getFastifyApiKeyContext(request)?.allowedBundleIds),
        });
        const normalizedOffset = Number.isFinite(offset) ? Math.max(offset, 0) : 0;
        return {
          ...result,
          artifacts: result.artifacts.map(artifactSummary),
          nextCursor: nextCursor(normalizedOffset, result.artifacts.length, result.total),
        };
      },
    );

    server.get(
      '/v1/artifacts/:id',
      { schema: getRouteContract('GET', '/v1/artifacts/:id'), preHandler: fastifyRequireApiKey },
      async (request, reply) => {
        const params = request.params as { id: string };
        const artifact = services.getArtifactById(params.id);
        if (!artifact || !services.artifactFileAvailable(artifact)) {
          reply.code(404);
          return apiErrorEnvelope('artifact not found', 'request_error', request.id);
        }
        if (!isBundleIdAllowed(getFastifyApiKeyContext(request)?.allowedBundleIds, artifact.bundleId)) {
          reply.code(403);
          return apiErrorEnvelope('this API key is not scoped to this bundleId', 'bundle_scope_denied', request.id);
        }
        return artifactSummary(artifact);
      },
    );
  };
}

export const artifactCatalogRoutes = createArtifactCatalogRoutes();

export function createTestFlightCatalogRoutes(
  services: TestFlightCatalogServices = { listTrains, listBuilds },
): FastifyPluginAsyncTypebox {
  return async (server) => {
    server.get(
      '/v1/testflight/:appId/trains',
      {
        schema: getRouteContract('GET', '/v1/testflight/:appId/trains'),
        preHandler: [fastifyRequireApiKey, fastifyRequireTestFlightScope],
      },
      async (request, reply) => {
        try {
          const params = request.params as { appId: string };
          return { trains: await services.listTrains(Number.parseInt(params.appId, 10)) };
        } catch (error) {
          reply.code(502);
          return testFlightLookupFailure(error, request.id);
        }
      },
    );

    server.get(
      '/v1/testflight/:appId/builds',
      {
        schema: getRouteContract('GET', '/v1/testflight/:appId/builds'),
        preHandler: [fastifyRequireApiKey, fastifyRequireTestFlightScope],
      },
      async (request, reply) => {
        try {
          const params = request.params as { appId: string };
          const query = request.query as { trainVersion: string };
          return { builds: await services.listBuilds(Number.parseInt(params.appId, 10), query.trainVersion) };
        } catch (error) {
          reply.code(502);
          return testFlightLookupFailure(error, request.id);
        }
      },
    );
  };
}

export const testFlightCatalogRoutes = createTestFlightCatalogRoutes();
