import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { config } from '../config.js';
import { log } from '../logger.js';
import { runDecrypt } from './runner.js';
import type { Job } from './types.js';

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

/** Creates a new job for bundleId, or returns the already in-flight one for that bundle. */
export function enqueueDecryptJob(bundleId: string): Job {
  const existing = findActiveJobForBundle(bundleId);
  if (existing) return existing;

  const job: Job = {
    id: randomUUID(),
    bundleId,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };

  jobs.set(job.id, job);
  queue.push(job.id);
  log.info('job queued', { jobId: job.id, bundleId });

  void runWorker();
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
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
      } catch (err) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = err instanceof Error ? err.message : String(err);
        log.error('job failed', { jobId: job.id, bundleId: job.bundleId, error: job.error });
      }

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
