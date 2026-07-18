import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { config } from '../config.js';
import { emitJobsChanged } from '../events.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('jobs');
import { EMBED_COLOR, notify } from '../notify.js';
import { sendPushToUser } from '../push.js';
import { clearAppleAuthAlert, getEffectiveDevices, recordJobHistory, setAppleAuthAlert, type DeviceRecord } from '../store/state.js';
import { looksLikeAppleAuthFailure } from '../util/appleAuth.js';
import { runDecrypt } from './runner.js';
import type { Job, JobSource, TestFlightJobSource } from './types.js';

const jobs = new Map<string, Job>();

const queue: string[] = [];
const busyDeviceIds = new Set<string>();

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

// Manual jobs are ordered by priority (highest first), FIFO among equal priority - scheduler jobs
// always jump straight to the front regardless, unchanged from before priority existed.
function insertByPriority(id: string, priority: number): void {
  const idx = queue.findIndex((qid) => (jobs.get(qid)?.priority ?? 0) < priority);
  if (idx === -1) queue.push(id);
  else queue.splice(idx, 0, id);
}

export function enqueueDecryptJob(
  bundleId: string,
  source: JobSource,
  externalVersionId?: string,
  testflight?: TestFlightJobSource,
  versionLabel?: string,
  queuedBy?: string,
  priority = 0,
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
    priority,
    status: 'queued',
    progress: 'queued',
    createdAt: Date.now(),
    waiters: [],
  };

  jobs.set(job.id, job);
  if (source === 'scheduler') {
    queue.unshift(job.id);
  } else {
    insertByPriority(job.id, priority);
  }
  log.info('job queued', { jobId: job.id, bundleId, externalVersionId, source, priority });
  emitJobsChanged();

  pumpWorkers();
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

  const runningIds = [...jobs.values()].filter((j) => j.status === 'running').map((j) => j.id);
  const ordered = [...runningIds, ...queue];
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
    deviceId: job.deviceId,
    ipaMetadata: job.ipaMetadata,
    ipaInfoPlist: job.ipaInfoPlist,
  };
}

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

export function cancelRunningJob(id: string, cancelledBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running' || !job.childProcess) return false;

  job.cancelledBy = cancelledBy;
  job.childProcess.kill('SIGTERM');
  log.info('job cancel requested', { jobId: id, bundleId: job.bundleId, cancelledBy });
  return true;
}

export function cancelJob(id: string, cancelledBy: string): boolean {
  return cancelQueuedJob(id, cancelledBy) || cancelRunningJob(id, cancelledBy);
}

export function prioritizeQueuedJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return false;

  const idx = queue.indexOf(id);
  if (idx <= 0) return idx === 0;

  queue.splice(idx, 1);
  queue.unshift(id);
  log.info('job bumped to front of queue', { jobId: id, bundleId: job.bundleId });
  emitJobsChanged();
  return true;
}

// TestFlight jobs are pinned to the primary device: installBuild() installs the app on one
// specific physical device via the tfauto bridge, so decrypting from a different device would
// either fail outright or silently grab whatever unrelated app happens to be installed there.
// App Store jobs have no such constraint and can go to any enabled device.
function isDispatchable(job: Job, device: DeviceRecord, primary: DeviceRecord): boolean {
  if (job.testflight) return device.id === primary.id;
  return true;
}

function takeNextDispatchableJobId(device: DeviceRecord, primary: DeviceRecord): string | undefined {
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (job && isDispatchable(job, device, primary)) {
      queue.splice(i, 1);
      return job.id;
    }
  }
  return undefined;
}

// Fans queued jobs out across every enabled, currently-idle device. The whole dispatch pass is
// synchronous (no `await` before each fire-and-forget runOneJob call), so Node's single-threaded
// event loop can't interleave two dispatch passes mid-loop - no lock needed beyond busyDeviceIds.
function pumpWorkers(): void {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  if (devices.length === 0) return;
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];

  for (const device of devices) {
    if (busyDeviceIds.has(device.id)) continue;
    const jobId = takeNextDispatchableJobId(device, primary);
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;

    busyDeviceIds.add(device.id);
    void runOneJob(device, job).finally(() => {
      busyDeviceIds.delete(device.id);
      pumpWorkers();
    });
  }
}

async function runOneJob(device: DeviceRecord, job: Job): Promise<void> {
  job.status = 'running';
  job.startedAt = Date.now();
  job.deviceId = device.id;
  log.info('job started', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id });
  emitJobsChanged();

  try {
    await runDecrypt(job, device);
    job.status = 'done';
    job.finishedAt = Date.now();
    log.info('job done', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, sizeBytes: job.fileSizeBytes });
    clearAppleAuthAlert();
  } catch (err) {
    job.status = 'failed';
    job.finishedAt = Date.now();
    job.error = err instanceof Error ? err.message : String(err);
    log.error('job failed', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: job.error });

    if (looksLikeAppleAuthFailure(job.error)) {
      setAppleAuthAlert(job.error);
      void notify('appleAuthAlert', {
        title: 'Possible App Store auth issue',
        description: `Decrypting **${job.bundleId}** failed with what looks like an authentication issue - it may need re-bootstrapping.`,
        color: EMBED_COLOR.warn,
        fields: [{ name: 'Error', value: `\`\`\`${job.error}\`\`\`` }],
      });
    }
  }

  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();

  if (job.queuedBy) {
    const label = job.versionLabel ? `${job.bundleId} (${job.versionLabel})` : job.bundleId;
    void sendPushToUser(job.queuedBy, {
      title: job.status === 'done' ? 'Decrypt finished' : 'Decrypt failed',
      body: job.status === 'done' ? `${label} is ready to download.` : `${label} failed: ${job.error ?? 'unknown error'}`,
    });
  }

  settle(job);
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
