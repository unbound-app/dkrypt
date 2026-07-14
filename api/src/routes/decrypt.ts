import { Router } from 'express';
import { config } from '../config.js';
import { requireApiKey, requireApiKeyOrSignedToken } from '../auth.js';
import { jobSummary, streamJobFile } from '../jobs/http.js';
import { enqueueDecryptJob, getJob, waitForJob } from '../jobs/store.js';

export const decryptRouter = Router();

const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;

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

  const job = enqueueDecryptJob(bundleId, 'manual');
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
