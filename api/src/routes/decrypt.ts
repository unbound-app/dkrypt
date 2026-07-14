import { Router } from 'express';
import { createReadStream } from 'node:fs';
import { config } from '../config.js';
import { requireApiKey, requireApiKeyOrSignedToken } from '../auth.js';
import { enqueueDecryptJob, getJob, reclaimJobFile, waitForJob } from '../jobs/store.js';
import type { Job } from '../jobs/types.js';
import { log } from '../logger.js';

export const decryptRouter = Router();

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

function jobSummary(job: Job) {
  return {
    id: job.id,
    bundleId: job.bundleId,
    status: job.status,
    progress: job.progress,
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    statusUrl: `/v1/jobs/${job.id}`,
    fileUrl: `/v1/jobs/${job.id}/file`,
  };
}

/**
 * GET /v1/decrypt?bundleId=com.example.app
 *
 * Enqueues (or joins an already in-flight) decrypt job for bundleId, then
 * holds the connection open and streams the IPA back directly once ready -
 * matching the simple "one URL, get the file" shape. Decryption can take
 * a long time, so if it isn't done within JOB_MAX_WAIT_SECONDS this falls
 * back to a 202 with a status/file URL to poll instead of hanging forever.
 */
decryptRouter.get('/v1/decrypt', requireApiKey, async (req, res) => {
  const bundleId = req.query.bundleId;
  if (typeof bundleId !== 'string' || !BUNDLE_ID_RE.test(bundleId)) {
    res.status(400).json({ error: 'query param bundleId is required and must look like a bundle identifier' });
    return;
  }

  const job = enqueueDecryptJob(bundleId);
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

/** GET /v1/jobs/:id - poll job status. */
decryptRouter.get('/v1/jobs/:id', requireApiKey, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found (finished jobs are pruned after retention window)' });
    return;
  }
  res.json(jobSummary(job));
});

/**
 * GET /v1/jobs/:id/file - stream the decrypted IPA.
 *
 * Accepts either the master API key or a short-lived signed token so the
 * GitHub Actions runner can fetch it without holding the master key.
 */
decryptRouter.get('/v1/jobs/:id/file', requireApiKeyOrSignedToken, async (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: 'job not found' });
    return;
  }

  if (job.status !== 'done' || !job.filePath) {
    res.status(409).json(jobSummary(job));
    return;
  }

  await streamJobFile(job, req, res);
});

async function streamJobFile(job: Job, req: import('express').Request, res: import('express').Response): Promise<void> {
  if (job.status !== 'done' || !job.filePath) {
    res.status(409).json(jobSummary(job));
    return;
  }

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${job.bundleId}.ipa"`);
  if (job.fileSizeBytes) res.setHeader('Content-Length', String(job.fileSizeBytes));

  const stream = createReadStream(job.filePath);

  await new Promise<void>((resolve) => {
    stream.on('error', (err) => {
      log.error('file stream error', { jobId: job.id, error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: 'failed to read decrypted file' });
      resolve();
    });

    stream.on('close', () => resolve());
    req.on('close', () => resolve());

    stream.pipe(res);
  });

  // Single-use: once the file has gone out over the wire, reclaim the disk
  // space immediately rather than waiting for the TTL sweeper.
  await reclaimJobFile(job);
}
