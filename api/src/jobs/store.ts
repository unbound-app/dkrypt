import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { config } from '../config.js';
import { emitJobsChanged } from '../events.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('jobs');
import { EMBED_COLOR, notify } from '../notify.js';
import { clearAppleAuthAlert, recordJobHistory, setAppleAuthAlert } from '../store/state.js';
import { looksLikeAppleAuthFailure } from '../util/appleAuth.js';
import { runDecrypt } from './runner.js';
import type { Job, JobSource, TestFlightJobSource } from './types.js';

const jobs = new Map<string, Job>();

const queue: string[] = [];
let workerRunning = false;

function findActiveJobForBundle(
  bundleId: string,
  externalVersionId: string | undefined,
  testflightBuildId: number | undefined,
): Job | undefined {
  for (const job of jobs.values()) {
    if (
      job.bundleId === bundleId &&
      job.externalVersionId === externalVersionId &&
      job.testflight?.build.id === testflightBuildId &&
      (job.status === 'queued' || job.status === 'running')
    ) {
      return job;
    }
  }
  return undefined;
}

export function enqueueDecryptJob(
  bundleId: string,
  source: JobSource,
  externalVersionId?: string,
  testflight?: TestFlightJobSource,
  versionLabel?: string,
  queuedBy?: string,
): Job {
  const existing = findActiveJobForBundle(bundleId, externalVersionId, testflight?.build.id);
  if (existing) return existing;

  const resolvedLabel = versionLabel ?? (testflight ? `${testflight.build.cfBundleShortVersion}_${testflight.build.cfBundleVersion}` : undefined);

  const job: Job = {
    id: randomUUID(),
    bundleId,
    externalVersionId,
    testflight,
    versionLabel: resolvedLabel,
    source,
    queuedBy,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };

  jobs.set(job.id, job);
  if (source === 'scheduler') {
    queue.unshift(job.id);
  } else {
    queue.push(job.id);
  }
  log.info('job queued', { jobId: job.id, bundleId, externalVersionId, source });
  emitJobsChanged();

  void runWorker();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getActiveJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getQueueInfo(jobId: string): { position: number; total: number } | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed') return undefined;

  const runningId = [...jobs.values()].find((j) => j.status === 'running')?.id;
  const ordered = runningId ? [runningId, ...queue] : queue;
  const idx = ordered.indexOf(jobId);
  return { position: idx === -1 ? ordered.length : idx + 1, total: ordered.length };
}

export function waitForJob(job: Job, timeoutMs: number): Promise<Job> {
  if (job.status === 'done' || job.status === 'failed') return Promise.resolve(job);

  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(job), timeoutMs);
    job.waiters.push((finished) => {
      clearTimeout(timer);
      resolve(finished);
    });
  });
}

function settle(job: Job): void {
  const waiters = job.waiters;
  job.waiters = [];
  for (const w of waiters) w(job);
}

function toHistoryEntry(job: Job) {
  return {
    id: job.id,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight,
    versionLabel: job.versionLabel,
    queuedBy: job.queuedBy,
    status: job.status as 'done' | 'failed',
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    source: job.source,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? Date.now(),
  };
}

// Only a still-queued job can be cancelled - once it's running, the physical device is already
// mid-decrypt and there's no way to interrupt it short of killing the ipadecrypt process.
export function cancelQueuedJob(id: string, cancelledBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return false;

  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);

  job.status = 'failed';
  job.error = `cancelled by ${cancelledBy}`;
  job.finishedAt = Date.now();
  log.info('job cancelled', { jobId: id, bundleId: job.bundleId, cancelledBy });

  recordJobHistory(toHistoryEntry(job));
  settle(job);
  // Leave it in `jobs` as a normal failed entry (same as a real failure) rather than deleting it
  // outright - a still-in-flight status poll for this id should see 'failed', not a bare 404, and
  // the sweeper already reclaims failed jobs after the usual retention window.
  emitJobsChanged();
  return true;
}

async function runWorker(): Promise<void> {
  if (workerRunning) return;
  workerRunning = true;

  try {
    let nextId: string | undefined;
    while ((nextId = queue.shift())) {
      const job = jobs.get(nextId);
      if (!job) continue;

      job.status = 'running';
      job.startedAt = Date.now();
      log.info('job started', { jobId: job.id, bundleId: job.bundleId });
      emitJobsChanged();

      try {
        await runDecrypt(job);
        job.status = 'done';
        job.finishedAt = Date.now();
        log.info('job done', { jobId: job.id, bundleId: job.bundleId, sizeBytes: job.fileSizeBytes });
        clearAppleAuthAlert();
      } catch (err) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = err instanceof Error ? err.message : String(err);
        log.error('job failed', { jobId: job.id, bundleId: job.bundleId, error: job.error });

        if (looksLikeAppleAuthFailure(job.error)) {
          setAppleAuthAlert(job.error);
          void notify('appleAuthAlert', '⚠️ App Store auth may need attention', {
            title: 'Possible App Store auth issue',
            description: `Decrypting **${job.bundleId}** failed with what looks like an authentication issue - it may need re-bootstrapping.`,
            color: EMBED_COLOR.warn,
            fields: [{ name: 'Error', value: `\`\`\`${job.error}\`\`\`` }],
          });
        }
      }

      recordJobHistory(toHistoryEntry(job));
      emitJobsChanged();

      settle(job);
    }
  } finally {
    workerRunning = false;
  }
}

async function cleanupJob(job: Job): Promise<void> {
  if (job.filePath) {
    await rm(job.filePath, { force: true }).catch((err: unknown) => {
      log.warn('failed to remove job file', { jobId: job.id, error: String(err) });
    });
  }
  jobs.delete(job.id);
  log.info('job cleaned up', { jobId: job.id, bundleId: job.bundleId });
}

export async function reclaimJobFile(job: Job): Promise<void> {
  job.downloadedAt = Date.now();
  await cleanupJob(job);
}

export function startJobSweeper(): void {
  const intervalMs = 60_000;
  setInterval(() => {
    const now = Date.now();
    const fileTtlMs = config.fileTtlMinutes * 60_000;
    const retentionMs = config.jobRetentionMinutes * 60_000;

    for (const job of jobs.values()) {
      if (job.status === 'done' && job.finishedAt && !job.downloadedAt && now - job.finishedAt > fileTtlMs) {
        log.warn('reclaiming undownloaded job file', { jobId: job.id, bundleId: job.bundleId });
        void cleanupJob(job);
        continue;
      }

      const finishedAt = job.finishedAt ?? job.createdAt;
      if ((job.status === 'done' || job.status === 'failed') && now - finishedAt > retentionMs) {
        void cleanupJob(job);
      }
    }
  }, intervalMs).unref();
}
