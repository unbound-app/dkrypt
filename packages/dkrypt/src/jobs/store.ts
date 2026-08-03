import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { sendMailToUser } from '#mail.js';
import { sendPushToUser } from '#push.js';
import { getApiKeyById, getEffectiveDevices, getUserPrefs, isBundleWatched, latestActiveShareLinkExpiry, recordDeviceActivity, recordJobHistory, recordShareLink, type DeviceRecord } from '#store/state.js';
import { uninstallFromPrimaryDevice } from '#appStoreInstall.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { runDecrypt } from '#jobs/runner.js';
import { appendJobTimelineEvent, type Job, type JobSource, type TestFlightJobSource } from '#jobs/types.js';
import { buildSignedFileUrlWithToken } from '#util/signedUrl.js';

const jobs = new Map<string, Job>();

const donePath = path.join(config.stateDir, 'done-jobs.json');
const activePath = path.join(config.stateDir, 'active-jobs.json');
const queue: string[] = [];
const busyDeviceIds = new Set<string>();

function serializableJob(job: Job): Omit<Job, 'childProcess' | 'waiters'> {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function persistDoneJobs(): void {
  const done = [...jobs.values()]
    .filter((j) => j.status === 'done')
    .map(serializableJob);
  writeFileSync(donePath, JSON.stringify(done));
}

function persistActiveJobs(): void {
  const active = [...jobs.values()]
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .map(serializableJob);
  writeFileSync(activePath, JSON.stringify(active));
}

function loadDoneJobs(): void {
  if (!existsSync(donePath)) return;
  try {
    const restored = JSON.parse(readFileSync(donePath, 'utf8')) as Job[];
    for (const job of restored) {
      if (!job.filePath || !existsSync(job.filePath)) continue;
      jobs.set(job.id, { ...job, waiters: [] });
    }
    log.info('restored completed jobs from previous process', { count: jobs.size });
  } catch (err) {
    log.warn('failed to restore done-jobs.json', { error: String(err) });
  }
}

export function recoverPersistedActiveJobs(saved: Job[], now = Date.now()): { queued: Job[]; interrupted: Job[] } {
  const queued: Job[] = [];
  const interrupted: Job[] = [];
  for (const job of saved) {
    const restored = { ...job, childProcess: undefined, waiters: [] };
    if (restored.status === 'queued') {
      queued.push(restored);
      continue;
    }
    if (restored.status === 'running') {
      interrupted.push({
        ...restored,
        status: 'failed',
        progress: 'interrupted by dkrypt restart',
        error: 'interrupted by dkrypt restart',
        finishedAt: now,
      });
    }
  }
  return { queued, interrupted };
}

function loadActiveJobs(): void {
  if (!existsSync(activePath)) return;
  try {
    const saved = JSON.parse(readFileSync(activePath, 'utf8')) as Job[];
    const { queued, interrupted } = recoverPersistedActiveJobs(saved);
    for (const job of queued) {
      jobs.set(job.id, job);
      insertByPriority(job.id, job.priority);
    }
    for (const job of interrupted) recordJobHistory(toHistoryEntry(job));
    persistActiveJobs();
    if (queued.length > 0 || interrupted.length > 0) {
      log.warn('recovered jobs after dkrypt restart', { queued: queued.length, interrupted: interrupted.length });
    }
  } catch (err) {
    log.warn('failed to restore active-jobs.json', { error: String(err) });
  }
}

loadDoneJobs();
loadActiveJobs();

const RETRY_BACKOFF_MS = 5_000;
const COMPLETION_SHARE_TTL_MINUTES = 60;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function findReusableCompletedJob(
  bundleId: string,
  externalVersionId: string | undefined,
  testflightBuildId: number | undefined,
): Job | undefined {
  if (externalVersionId === undefined && testflightBuildId === undefined) return undefined;
  for (const job of jobs.values()) {
    if (
      job.bundleId === bundleId &&
      job.externalVersionId === externalVersionId &&
      job.testflight?.build.id === testflightBuildId &&
      job.status === 'done' &&
      job.filePath &&
      existsSync(job.filePath)
    ) {
      return job;
    }
  }
  return undefined;
}

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
  preferredDeviceId?: string,
  apiKeyId?: string,
): Job {
  const existing = findActiveJobForBundle(bundleId, externalVersionId, testflight?.build.id);
  if (existing) return existing;
  const reusable = findReusableCompletedJob(bundleId, externalVersionId, testflight?.build.id);
  if (reusable) return reusable;

  const resolvedLabel = versionLabel ?? (testflight ? `${testflight.build.cfBundleShortVersion}_${testflight.build.cfBundleVersion}` : 'Current App Store release');

  const job: Job = {
    id: randomUUID(),
    bundleId,
    externalVersionId,
    testflight,
    versionLabel: resolvedLabel,
    source,
    queuedBy,
    apiKeyId,
    preferredDeviceId,
    priority,
    status: 'queued',
    progress: 'queued',
    timeline: [{ at: Date.now(), label: 'Queued', status: 'queued' }],
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
  persistActiveJobs();
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

export function getRetainedJobArtifacts(): Job[] {
  return [...jobs.values()].filter((job) => job.status === 'done' && !!job.filePath && existsSync(job.filePath));
}

export function mergeActiveJobOwner(targetUserId: string, sourceUserId: string): void {
  let changed = false;
  for (const job of jobs.values()) {
    if (job.queuedBy === sourceUserId) {
      job.queuedBy = targetUserId;
      changed = true;
    }
  }
  if (changed) emitJobsChanged();
}

export function getQueueInfo(jobId: string): { position: number; total: number } | undefined {
  const job = jobs.get(jobId);
  if (!job || job.status === 'done' || job.status === 'failed') return undefined;

  const runningIds = [...jobs.values()].filter((j) => j.status === 'running').map((j) => j.id);
  const ordered = [...runningIds, ...queue];
  const idx = ordered.indexOf(jobId);
  return { position: idx === -1 ? ordered.length : idx + 1, total: ordered.length };
}

export function getQueueReason(job: Job): string | undefined {
  if (job.status !== 'queued') return undefined;
  const devices = getEffectiveDevices().filter((device) => device.enabled);
  if (devices.length === 0) return 'Waiting for an enabled device';

  const primary = devices.find((device) => device.isPrimary) ?? devices[0];
  const eligible = devices.filter((device) => isDispatchable(job, device, primary));
  if (eligible.length === 0) return job.testflight ? 'Waiting for the primary device' : 'Waiting for a compatible device';

  if (config.userConcurrencyCap > 0 && job.queuedBy && queuedByActiveCount(job.queuedBy) >= config.userConcurrencyCap) {
    return `Waiting for your concurrency limit (${config.userConcurrencyCap}) to free up`;
  }
  if (job.apiKeyId) {
    const maxConcurrent = getApiKeyById(job.apiKeyId)?.maxConcurrent;
    if (maxConcurrent && apiKeyActiveCount(job.apiKeyId) >= maxConcurrent) return `Waiting for API key concurrency limit (${maxConcurrent}) to free up`;
  }

  const available = eligible.filter((device) => !busyDeviceIds.has(device.id));
  if (available.length === 0) {
    const names = eligible.map((device) => device.name).join(', ');
    return `Waiting for ${names} to become available`;
  }

  const queue = getQueueInfo(job.id);
  if (queue && queue.position > 1) return `Waiting behind ${queue.position - 1} job${queue.position === 2 ? '' : 's'}`;
  return undefined;
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
    timeline: job.timeline,
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
  appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
  log.info('job cancelled', { jobId: id, bundleId: job.bundleId, cancelledBy });

  persistActiveJobs();
  recordJobHistory(toHistoryEntry(job));
  settle(job);

  emitJobsChanged();
  return true;
}

export function cancelRunningJob(id: string, cancelledBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'running') return false;
  if (job.cancelledBy) return true;

  job.cancelledBy = cancelledBy;
  job.progress = 'cancelling…';
  appendJobTimelineEvent(job, job.progress, 'running');
  job.childProcess?.kill('SIGTERM');
  log.info('job cancel requested', { jobId: id, bundleId: job.bundleId, cancelledBy });
  persistActiveJobs();
  emitJobsChanged();
  return true;
}

export function cancelJob(id: string, cancelledBy: string): boolean {
  return cancelQueuedJob(id, cancelledBy) || cancelRunningJob(id, cancelledBy);
}

export function releasePinnedJobsForDevice(deviceId: string): number {
  let released = 0;
  for (const id of queue) {
    const job = jobs.get(id);
    if (job && job.preferredDeviceId === deviceId && !job.testflight) {
      job.preferredDeviceId = undefined;
      released += 1;
    }
  }
  if (released > 0) {
    log.info('released device-pinned queued jobs after device went unreachable', { deviceId, released });
    emitJobsChanged();
    pumpWorkers();
  }
  return released;
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

export function reorderQueue(orderedIds: string[]): boolean {
  const known = new Set(queue);
  const requested = orderedIds.filter((id) => known.has(id));
  if (requested.length === 0) return false;

  const requestedSet = new Set(requested);
  const remainder = queue.filter((id) => !requestedSet.has(id));
  const next = [...requested, ...remainder];

  const changed = next.some((id, i) => id !== queue[i]);
  if (!changed) return false;

  queue.length = 0;
  queue.push(...next);
  log.info('queue manually reordered', { orderedIds: requested });
  emitJobsChanged();
  return true;
}

function isDispatchable(job: Job, device: DeviceRecord, primary: DeviceRecord): boolean {
  if (job.preferredDeviceId && job.preferredDeviceId !== device.id) return false;
  if (job.testflight) return device.id === primary.id;
  return true;
}

function deviceScore(device: DeviceRecord, primary: DeviceRecord): number {
  const cachedHealth = getCachedDeviceHealth(device.id);
  if (!cachedHealth) return device.id === primary.id ? 1 : 0;
  const health = cachedHealth.value;
  if (!health.reachable) return -10_000;

  let score = device.id === primary.id ? 10 : 0;
  score += Math.min(health.storageFreeBytes ? Math.floor(health.storageFreeBytes / (1024 * 1024 * 1024)) : 0, 100);
  score += health.batteryCharging ? 20 : 0;
  score += health.batteryPercent ? Math.floor(health.batteryPercent / 5) : 0;
  score -= health.batteryTemperatureC && health.batteryTemperatureC >= 40 ? 50 : 0;
  score -= health.storageUsedPercent && health.storageUsedPercent >= 0.9 ? 50 : 0;
  return score;
}

function queuedByActiveCount(username: string): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue;
    if (job.queuedBy?.toLowerCase() === username.toLowerCase()) count += 1;
  }
  return count;
}

function apiKeyActiveCount(apiKeyId: string): number {
  let count = 0;
  for (const job of jobs.values()) {
    if (job.status === 'running' && job.apiKeyId === apiKeyId) count += 1;
  }
  return count;
}

function takeNextDispatchableJobId(device: DeviceRecord, primary: DeviceRecord): string | undefined {
  const cap = config.userConcurrencyCap;
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (!job || !isDispatchable(job, device, primary)) continue;
    if (cap > 0 && job.queuedBy && queuedByActiveCount(job.queuedBy) >= cap) continue;
    if (job.apiKeyId) {
      const keyMaxConcurrent = getApiKeyById(job.apiKeyId)?.maxConcurrent;
      if (keyMaxConcurrent && apiKeyActiveCount(job.apiKeyId) >= keyMaxConcurrent) continue;
    }
    queue.splice(i, 1);
    return job.id;
  }
  return undefined;
}

function pumpWorkers(): void {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  if (devices.length === 0) return;
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];

  const rankedDevices = [...devices].sort((a, b) => deviceScore(b, primary) - deviceScore(a, primary));
  for (const device of rankedDevices) {
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
  appendJobTimelineEvent(job, `Started on ${device.name}`, 'running', job.startedAt);
  log.info('job started', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id });
  recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: `Started ${job.testflight ? 'TestFlight' : 'App Store'} decrypt` });
  persistActiveJobs();
  emitJobsChanged();

  try {
    await runDecrypt(job, device);
    job.status = 'done';
    job.finishedAt = Date.now();
    appendJobTimelineEvent(job, 'Finished', 'done', job.finishedAt);
    log.info('job done', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, sizeBytes: job.fileSizeBytes });
    recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt completed' });
    persistDoneJobs();
    persistActiveJobs();
  } catch (err) {
    const message = job.cancelledBy ? `cancelled by ${job.cancelledBy}` : err instanceof Error ? err.message : String(err);
    const canRetry = !job.cancelledBy && (job.retryCount ?? 0) === 0;
    if (canRetry) {
      job.retryCount = (job.retryCount ?? 0) + 1;
      job.progress = 'retrying after a transient failure…';
      appendJobTimelineEvent(job, job.progress, 'running');
      log.warn('job failed, retrying once after backoff', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: message });
      persistActiveJobs();
      emitJobsChanged();
      await sleep(RETRY_BACKOFF_MS);
      if (job.cancelledBy) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = `cancelled by ${job.cancelledBy}`;
        appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
        log.info('job cancelled during retry backoff', { jobId: job.id, bundleId: job.bundleId, cancelledBy: job.cancelledBy });
        persistActiveJobs();
        recordJobHistory(toHistoryEntry(job));
        emitJobsChanged();
        settle(job);
        return;
      }
      return runOneJob(device, job);
    }

    job.status = 'failed';
    job.finishedAt = Date.now();
    job.error = message;
    appendJobTimelineEvent(job, `Failed: ${message}`, 'failed', job.finishedAt);
    log.error('job failed', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: job.error, retried: (job.retryCount ?? 0) > 0 });
    recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt failed' });
    persistActiveJobs();
  }

  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();

  const completionShare = job.status === 'done'
    ? buildSignedFileUrlWithToken(job.id, COMPLETION_SHARE_TTL_MINUTES)
    : undefined;
  if (completionShare) {
    recordShareLink(
      job.id,
      job.bundleId,
      completionShare.token,
      job.queuedBy ?? 'system',
      completionShare.expiresAtMs,
    );
  }

  if (job.queuedBy) {
    const prefs = getUserPrefs(job.queuedBy);
    const label = job.versionLabel ? `${job.bundleId} (${job.versionLabel})` : job.bundleId;
    const title = job.status === 'done' ? 'Decrypt finished' : 'Decrypt failed';
    const body = job.status === 'done' ? `${label} is ready to download.` : `${label} failed: ${job.error ?? 'unknown error'}`;

    const shouldPush = job.status === 'done' ? (prefs.pushOnSuccess ?? true) : (prefs.pushOnFailure ?? true);
    if (shouldPush) {
      void sendPushToUser(job.queuedBy, {
        title,
        body,
        url: completionShare?.url ?? `/?job=${encodeURIComponent(job.id)}`,
        actions: completionShare
          ? [{ action: 'download', title: 'Download' }]
          : [{ action: 'open-job', title: 'Open job' }],
      });
    }

    const shouldMail = job.status === 'done' ? (prefs.emailOnSuccess ?? false) : (prefs.emailOnFailure ?? false);
    if (shouldMail) void sendMailToUser(job.queuedBy, {
      subject: title,
      text: completionShare ? `${body}\n\nDownload: ${completionShare.url}` : body,
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
  persistDoneJobs();
}

export async function reclaimJobFile(job: Job): Promise<void> {
  if (latestActiveShareLinkExpiry(job.id) !== undefined) return;
  job.downloadedAt = Date.now();
  await cleanupJob(job);
}

async function reclaimAndMaybeUninstall(job: Job): Promise<void> {
  const { bundleId, status } = job;
  await cleanupJob(job);
  if (status === 'done' && !isBundleWatched(bundleId)) {
    await uninstallFromPrimaryDevice(bundleId).catch((err: unknown) => {
      log.warn('device uninstall during sweep failed', { bundleId, error: String(err) });
    });
  }
}

export function startJobSweeper(): void {
  pumpWorkers();
  const intervalMs = 60_000;
  setInterval(() => {
    const now = Date.now();
    const fileTtlMs = config.fileTtlMinutes * 60_000;
    const retentionMs = config.jobRetentionMinutes * 60_000;

    for (const job of jobs.values()) {

      const shareLinkExpiry = latestActiveShareLinkExpiry(job.id) ?? 0;

      if (job.status === 'done' && job.finishedAt && !job.downloadedAt && now - job.finishedAt > fileTtlMs && now > shareLinkExpiry) {
        log.warn('reclaiming undownloaded job file', { jobId: job.id, bundleId: job.bundleId });
        void reclaimAndMaybeUninstall(job);
        continue;
      }

      const finishedAt = job.finishedAt ?? job.createdAt;
      if ((job.status === 'done' || job.status === 'failed') && now - finishedAt > retentionMs && now > shareLinkExpiry) {
        void reclaimAndMaybeUninstall(job);
      }
    }
  }, intervalMs).unref();
}
