import type { Request, Response } from '#http.js';
import { createReadStream, existsSync } from 'node:fs';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { latestActiveShareLinkExpiry } from '#store/state.js';
import { getQueueInfo, getQueueReason } from '#jobs/store.js';
import type { Job } from '#jobs/types.js';
import { artifactDownloadName, artifactFileAvailable, getArtifactForJob, touchArtifact } from '#artifacts.js';

export function jobFileAvailable(job: Job | undefined): boolean {
  if (!job || job.status !== 'done') return false;
  const artifact = getArtifactForJob(job);
  if (artifact) return artifactFileAvailable(artifact);
  return !!job.filePath && existsSync(job.filePath);
}

export function jobSummary(job: Job) {
  const fileExpiresAt =
    job.status === 'done' && job.finishedAt && !job.downloadedAt && !job.artifactId
      ? new Date(Math.max(job.finishedAt + config.fileTtlMinutes * 60_000, latestActiveShareLinkExpiry(job.id) ?? 0)).toISOString()
      : undefined;

  return {
    id: job.id,
    correlationId: job.id,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight
      ? { appId: job.testflight.appId, buildId: job.testflight.build.id, version: job.testflight.build.cfBundleShortVersion, buildNumber: job.testflight.build.cfBundleVersion }
      : undefined,
    versionLabel: job.versionLabel,
    source: job.source,
    channel: job.testflight ? 'testflight' : 'appstore',
    queuedBy: job.queuedBy,
    priority: job.priority,
    status: job.status,
    progress: job.progress,
    error: job.error,
    artifactId: job.artifactId,
    artifactUrl: job.artifactId ? `/v1/artifacts/${job.artifactId}/file` : undefined,
    cacheHit: job.cacheHit,
    sizeBytes: job.fileSizeBytes,
    sha256: job.sha256,
    createdAt: new Date(job.createdAt).toISOString(),
    startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : undefined,
    finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : undefined,
    fileExpiresAt,
    queue: getQueueInfo(job.id),
    queueReason: getQueueReason(job),
    statusUrl: `/v1/jobs/${job.id}`,
    fileUrl: `/v1/jobs/${job.id}/file`,
  };
}

export async function streamFilePath(
  filePath: string,
  req: Request,
  res: Response,
  filename: string,
  fileSizeBytes: number | undefined,
  contextId: string,
): Promise<void> {
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  if (fileSizeBytes) res.setHeader('Content-Length', String(fileSizeBytes));

  const stream = createReadStream(filePath);

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    stream.on('error', (err) => {
      log.error('file stream error', { contextId, error: String(err) });
      if (!res.headersSent) res.status(500).json({ error: 'failed to read decrypted file' });
      finish();
    });

    stream.on('close', finish);
    req.on('close', () => {
      stream.destroy();
      finish();
    });

    // Bun's Node-compatible Readable is not reliably handled by Fastify's
    // reply.send() stream adapter. Hijack the reply and pipe to the native
    // response so retained artifacts are sent instead of an empty body.
    res.reply.hijack();
    stream.pipe(res.raw);
  });
}

export async function streamJobFile(job: Job, req: Request, res: Response): Promise<void> {
  const artifact = getArtifactForJob(job);
  const filePath = artifact?.filePath ?? job.filePath;
  if (!jobFileAvailable(job) || !filePath) {
    res.status(409).json(jobSummary(job));
    return;
  }

  if (artifact) await touchArtifact(artifact);

  await streamFilePath(
    filePath,
    req,
    res,
    artifact ? artifactDownloadName(artifact) : `${job.bundleId}.ipa`,
    job.fileSizeBytes,
    job.id,
  );
}
