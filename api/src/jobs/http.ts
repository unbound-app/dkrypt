import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { latestActiveShareLinkExpiry } from '#store/state.js';
import { getQueueInfo } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';

export function jobSummary(job: Job) {
  const fileExpiresAt =
    job.status === 'done' && job.finishedAt && !job.downloadedAt
      ? new Date(Math.max(job.finishedAt + config.fileTtlMinutes * 60_000, latestActiveShareLinkExpiry(job.id) ?? 0)).toISOString()
      : undefined;

  return {
    id: job.id,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight
      ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
      : undefined,
    versionLabel: job.versionLabel,
    source: job.source,
    queuedBy: job.queuedBy,
    priority: job.priority,
    status: job.status,
    progress: job.progress,
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    fileExpiresAt,
    queue: getQueueInfo(job.id),
    statusUrl: `/v1/jobs/${job.id}`,
    fileUrl: `/v1/jobs/${job.id}/file`,
  };
}

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
}
