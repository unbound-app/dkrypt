import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('jobs');
import { getQueueInfo, reclaimJobFile } from './store.js';
import type { Job } from './types.js';

export function jobSummary(job: Job) {
  return {
    id: job.id,
    bundleId: job.bundleId,
    source: job.source,
    status: job.status,
    progress: job.progress,
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    queue: getQueueInfo(job.id),
    statusUrl: `/v1/jobs/${job.id}`,
    fileUrl: `/v1/jobs/${job.id}/file`,
  };
}

/** Streams a finished job's IPA to the response, then reclaims the file from disk. */
export async function streamJobFile(job: Job, req: Request, res: Response): Promise<void> {
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

  // Reclaim immediately rather than waiting for the TTL sweeper.
  await reclaimJobFile(job);
}
