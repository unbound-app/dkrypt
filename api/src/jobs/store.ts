import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { config } from '../config.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('jobs');
import { notify } from '../notify.js';
import { clearAppleAuthAlert, recordJobHistory, setAppleAuthAlert } from '../store/state.js';
import { looksLikeAppleAuthFailure } from '../util/appleAuth.js';
import { runDecrypt } from './runner.js';
import type { Job, JobSource } from './types.js';

const jobs = new Map<string, Job>();

// The jailbroken device is a single physical resource driven over SSH by
// the ipadecrypt CLI - it cannot run two decrypts concurrently. Every job,
// whether from the manual endpoint or the scheduler, goes through this one
// FIFO queue so they never collide on the device.
const queue: string[] = [];
let workerRunning = false;

function findActiveJobForBundle(bundleId: string): Job | undefined {
  for (const job of jobs.values()) {
    if (job.bundleId === bundleId && (job.status === 'queued' || job.status === 'running')) {
      return job;
    }
  }
  return undefined;
}

/**
 * Creates a new job for bundleId, or returns the already in-flight one for
 * that bundle. Scheduler jobs jump ahead of anything dashboard-queued (but
 * never ahead of a job already running - the device can't be interrupted
 * mid-decrypt) since the automated release watch matters more than someone
 * poking around the dashboard for fun.
 */
export function enqueueDecryptJob(bundleId: string, source: JobSource): Job {
  const existing = findActiveJobForBundle(bundleId);
  if (existing) return existing;

  const job: Job = {
    id: randomUUID(),
    bundleId,
    source,
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
  log.info('job queued', { jobId: job.id, bundleId, source });

  void runWorker();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getActiveJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
}

/** 1-based position among not-yet-finished jobs (a running job is position 1), plus the total. */
export function getQueueInfo(jobId: string): { position: number; total: number } | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed') return undefined;

  const runningId = [...jobs.values()].find((j) => j.status === 'running')?.id;
  const ordered = runningId ? [runningId, ...queue] : queue;
  const idx = ordered.indexOf(jobId);
  return { position: idx === -1 ? ordered.length : idx + 1, total: ordered.length };
}

/** Resolves once the job reaches done/failed, or immediately if it already has. */
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
          void notify(
            `⚠️ ipadecrypt-service: decrypting **${job.bundleId}** failed with what looks like an App Store auth issue - it may need re-bootstrapping.\n\`${job.error}\``,
          );
        }
      }

      recordJobHistory({
        id: job.id,
        bundleId: job.bundleId,
        status: job.status as 'done' | 'failed',
        error: job.error,
        sizeBytes: job.fileSizeBytes,
        source: job.source,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt ?? Date.now(),
      });

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

/** Deletes a job's file immediately (called right after a successful download stream). */
export async function reclaimJobFile(job: Job): Promise<void> {
  job.downloadedAt = Date.now();
  await cleanupJob(job);
}

/**
 * Background sweep: finished jobs whose file was never downloaded get
 * reclaimed after FILE_TTL_MINUTES; anything else (queued/running edge
 * cases, failed jobs) is pruned after JOB_RETENTION_MINUTES so the map
 * doesn't grow unbounded.
 */
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
