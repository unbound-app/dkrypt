import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('jobs');
import { sendMailToUser } from '#mail.js';
import { sendPushToUser } from '#push.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getApiKeyById, getDevice, getEffectiveDevices, getProject, getUserPrefs, isBundleWatched, recordDeviceActivity, recordJobHistory, type DeviceRecord } from '#store/state.js';
import { uninstallFromDevice } from '#appStoreInstall.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import { runDecrypt } from '#jobs/runner.js';
import { appendJobTimelineEvent, type Job, type JobSource, type TestFlightJobSource } from '#jobs/types.js';
import { artifactKeyForJob, buildDashboardArtifactFileUrl, getArtifactById, getArtifactByKey, getArtifactForJob, linkArtifactToProject, migrateLegacyPath, type ArtifactRecord } from '#artifacts.js';
import { closePersistedJobs, loadPersistedJobs, replacePersistedJobs } from '#jobs/repository.js';
import { terminateChildProcess } from '#jobs/process.js';
import { classifyJobFailure } from '#util/failureCategory.js';
import { incrementMetric, observeMetric } from '#metrics.js';
import { recordJobStarted } from '#jobs/metrics.js';
import { withCorrelation } from '#correlation.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { runWithJobDeadline } from '#jobs/deadline.js';
import { delayWithSignal } from '#util/abort.js';

const jobs = new Map<string, Job>();

const donePath = path.join(config.stateDir, 'done-jobs.json');
const activePath = path.join(config.stateDir, 'active-jobs.json');
const queue: string[] = [];
const busyDeviceIds = new Set<string>();
const runningJobs = new Map<string, Promise<void>>();
const runningJobControllers = new Map<string, AbortController>();
const queuedDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
const queueSloNotified = new Set<string>();
let acceptingJobs = true;

function serializableJob(job: Job): Omit<Job, 'childProcess' | 'waiters'> {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function writeLegacyMirror(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

function persistDoneJobs(): void {
  const done = [...jobs.values()]
    .filter((j) => j.status === 'done')
    .map(serializableJob);
  writeLegacyMirror(donePath, done);
  replacePersistedJobs(jobs.values());
}

function persistActiveJobs(): void {
  const active = [...jobs.values()]
    .filter((j) => j.status === 'queued' || j.status === 'running')
    .map(serializableJob);
  writeLegacyMirror(activePath, active);
  replacePersistedJobs(jobs.values());
}

function loadDoneJobs(): void {
  if (!existsSync(donePath)) return;
  try {
    const restored = JSON.parse(readFileSync(donePath, 'utf8')) as Job[];
    for (const job of restored) {
      job.filePath = migrateLegacyPath(job.filePath);
      if (!job.filePath || !existsSync(job.filePath)) continue;
      jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
    }
    log.info('restored completed jobs from previous process', { count: jobs.size });
  } catch (err) {
    throw new Error(`could not restore done jobs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function recoverPersistedActiveJobs(saved: Job[], now = Date.now()): { queued: Job[]; interrupted: Job[] } {
  const queued: Job[] = [];
  const interrupted: Job[] = [];
  for (const job of saved) {
    const restored = { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, childProcess: undefined, waiters: [] };
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
      scheduleQueuedDeadline(job);
    }
    for (const job of interrupted) recordJobHistory(toHistoryEntry(job));
    persistActiveJobs();
    if (queued.length > 0 || interrupted.length > 0) {
      log.warn('recovered jobs after dkrypt restart', { queued: queued.length, interrupted: interrupted.length });
    }
  } catch (err) {
    throw new Error(`could not restore active jobs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function loadDatabaseJobs(): boolean {
  const saved = loadPersistedJobs();
  if (saved.length === 0) return false;
  const { queued, interrupted } = recoverPersistedActiveJobs(saved as Job[]);
  for (const job of saved.filter((entry) => entry.status === 'done' || entry.status === 'failed')) {
    job.filePath = migrateLegacyPath(job.filePath);
    if (job.status === 'done' && job.filePath && !existsSync(job.filePath)) job.filePath = undefined;
    jobs.set(job.id, { ...job, projectId: job.projectId ?? DEFAULT_PROJECT_ID, waiters: [] });
  }
  for (const job of queued) {
    jobs.set(job.id, { ...job, waiters: [] });
    insertByPriority(job.id, job.priority);
    scheduleQueuedDeadline(job);
  }
  for (const job of interrupted) recordJobHistory(toHistoryEntry(job));
  replacePersistedJobs(jobs.values());
  return true;
}

if (!loadDatabaseJobs()) {
  loadDoneJobs();
  loadActiveJobs();
  replacePersistedJobs(jobs.values());
}

const RETRY_BACKOFF_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findActiveJobForBundle(
  bundleId: string,
  externalVersionId: string | undefined,
  testflightBuildId: number | undefined,
  projectId: string,
): Job | undefined {
  for (const job of jobs.values()) {
    if (
      job.bundleId === bundleId &&
      job.externalVersionId === externalVersionId &&
      job.testflight?.build.id === testflightBuildId &&
      (job.projectId ?? DEFAULT_PROJECT_ID) === projectId &&
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
  projectId: string,
): Job | undefined {
  if (externalVersionId === undefined && testflightBuildId === undefined) return undefined;
  for (const job of jobs.values()) {
    if (
      job.bundleId === bundleId &&
      job.externalVersionId === externalVersionId &&
      job.testflight?.build.id === testflightBuildId &&
      (job.projectId ?? DEFAULT_PROJECT_ID) === projectId &&
      job.status === 'done' &&
      job.filePath &&
      existsSync(job.filePath)
    ) {
      return job;
    }
  }
  return undefined;
}

function createCachedJob(
  bundleId: string,
  source: JobSource,
  externalVersionId: string | undefined,
  testflight: TestFlightJobSource | undefined,
  versionLabel: string | undefined,
  queuedBy: string | undefined,
  priority: number,
  apiKeyId: string | undefined,
  projectId: string,
  artifact: ArtifactRecord,
): Job {
  const now = Date.now();
  const resolvedLabel = versionLabel ?? artifact.versionLabel;
  const job: Job = {
    id: randomUUID(),
    correlationId: randomUUID(),
    projectId,
    bundleId,
    externalVersionId,
    testflight,
    versionLabel: resolvedLabel,
    source,
    queuedBy,
    apiKeyId,
    priority,
    status: 'done',
    progress: 'artifact cache hit',
    timeline: [
      { at: now, label: 'Artifact cache hit', status: 'done' },
      { at: now, label: 'Finished', status: 'done' },
    ],
    artifactId: artifact.id,
    cacheHit: true,
    filePath: artifact.filePath,
    fileSizeBytes: artifact.fileSizeBytes,
    sha256: artifact.sha256,
    createdAt: now,
    deadlineAt: now + config.jobMaxWaitSeconds * 1000,
    attempt: 1,
    finishedAt: now,
    waiters: [],
  };
  jobs.set(job.id, job);
  persistDoneJobs();
  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();
  return job;
}

function insertByPriority(id: string, priority: number): void {
  const idx = queue.findIndex((qid) => (jobs.get(qid)?.priority ?? 0) < priority);
  if (idx === -1) queue.push(id);
  else queue.splice(idx, 0, id);
}

function clearQueuedDeadline(id: string): void {
  const timer = queuedDeadlineTimers.get(id);
  if (timer) clearTimeout(timer);
  queuedDeadlineTimers.delete(id);
}

function failExpiredQueuedJob(job: Job, now = Date.now()): void {
  if (job.status !== 'queued' || job.deadlineAt === undefined || job.deadlineAt > now) return;
  clearQueuedDeadline(job.id);
  const index = queue.indexOf(job.id);
  if (index !== -1) queue.splice(index, 1);
  job.status = 'failed';
  job.deadlineExceeded = true;
  job.progress = 'job deadline exceeded';
  job.error = 'job deadline exceeded while waiting in the queue';
  job.failureClass = classifyJobFailure('job deadline exceeded');
  job.finishedAt = now;
  appendJobTimelineEvent(job, `Failed: ${job.error}`, 'failed', now);
  incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
  log.warn('queued job expired before it could start', { jobId: job.id, bundleId: job.bundleId });
  recordJobHistory(toHistoryEntry(job));
  settle(job);
  persistActiveJobs();
  emitJobsChanged();
}

function scheduleQueuedDeadline(job: Job): void {
  clearQueuedDeadline(job.id);
  if (job.status !== 'queued' || job.deadlineAt === undefined) return;
  const timer = setTimeout(() => {
    queuedDeadlineTimers.delete(job.id);
    if (job.status !== 'queued') return;
    if (job.deadlineAt !== undefined && job.deadlineAt > Date.now()) {
      scheduleQueuedDeadline(job);
      return;
    }
    failExpiredQueuedJob(job);
  }, Math.max(1, job.deadlineAt - Date.now()));
  timer.unref();
  queuedDeadlineTimers.set(job.id, timer);
}

function terminateJobProcess(job: Job): void {
  const child = job.childProcess;
  if (!child) return;
  terminateChildProcess(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (job.childProcess === child) terminateChildProcess(child, 'SIGKILL');
  }, config.jobProcessGraceSeconds * 1000);
  timer.unref();
}

function expireOverdueQueuedJobs(now = Date.now()): void {
  for (const id of [...queue]) {
    const job = jobs.get(id);
    if (job) failExpiredQueuedJob(job, now);
  }
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
  projectId = DEFAULT_PROJECT_ID,
): Job {
  if (!acceptingJobs) throw new Error('dkrypt is shutting down and is not accepting new jobs');
  const existing = findActiveJobForBundle(bundleId, externalVersionId, testflight?.build.id, projectId);
  if (existing) return existing;
  enforceProjectQuotas(projectId);
  const artifactKey = artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId, testflight, versionLabel });
  const artifact = getArtifactByKey(artifactKey);
  if (artifact) {
    linkArtifactToProject(artifact.id, projectId);
    return createCachedJob(bundleId, source, externalVersionId, testflight, versionLabel, queuedBy, priority, apiKeyId, projectId, artifact);
  }
  const reusable = findReusableCompletedJob(bundleId, externalVersionId, testflight?.build.id, projectId);
  if (reusable) return reusable;

  const resolvedLabel = versionLabel ?? (testflight ? `${testflight.build.cfBundleShortVersion}_${testflight.build.cfBundleVersion}` : 'Current App Store release');

  const now = Date.now();
  const job: Job = {
    id: randomUUID(),
    correlationId: randomUUID(),
    projectId,
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
    timeline: [{ at: now, label: 'Queued', status: 'queued' }],
    createdAt: now,
    deadlineAt: now + config.jobMaxWaitSeconds * 1000,
    attempt: 1,
    waiters: [],
  };

  jobs.set(job.id, job);
  if (source === 'scheduler') {
    queue.unshift(job.id);
  } else {
    insertByPriority(job.id, priority);
  }
  scheduleQueuedDeadline(job);
  log.info('job queued', { jobId: job.id, bundleId, externalVersionId, source, priority });
  persistActiveJobs();
  emitJobsChanged();

  pumpWorkers();
  return job;
}

class ProjectQuotaExceededError extends Error {
  readonly statusCode = 429;

  constructor(message: string) {
    super(message);
    this.name = 'ProjectQuotaExceededError';
  }
}

function enforceProjectQuotas(projectId: string): void {
  const project = getProject(projectId);
  if (!project || project.archivedAt !== undefined) {
    const error = new Error('project is unavailable');
    Object.assign(error, { statusCode: 404 });
    throw error;
  }
  const active = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && (job.status === 'queued' || job.status === 'running'));
  if (project.maxConcurrentJobs && active.length >= project.maxConcurrentJobs) {
    throw new ProjectQuotaExceededError('project concurrency limit reached');
  }
  if (!project.dailyJobQuota) return;
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const knownIds = new Set([...jobs.values()].map((job) => job.id));
  const jobsToday = [...jobs.values()].filter((job) => (job.projectId ?? DEFAULT_PROJECT_ID) === projectId && job.createdAt >= dayStart).length;
  const historyToday = getAllJobHistory().filter((entry) => (entry.projectId ?? DEFAULT_PROJECT_ID) === projectId && entry.createdAt >= dayStart && !knownIds.has(entry.id)).length;
  if (jobsToday + historyToday >= project.dailyJobQuota) throw new ProjectQuotaExceededError('project daily job limit reached');
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function getActiveJobs(): Job[] {
  return [...jobs.values()].filter((j) => j.status === 'queued' || j.status === 'running');
}

export function getArtifactBackedJobs(): Job[] {
  return [...jobs.values()].filter((job) => job.status === 'done' && !!job.filePath);
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

  const eligible = devices.filter((device) => isJobDispatchable(job, device));
  if (eligible.length === 0) return 'Waiting for a compatible device';

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
    correlationId: job.correlationId,
    projectId: job.projectId ?? DEFAULT_PROJECT_ID,
    bundleId: job.bundleId,
    externalVersionId: job.externalVersionId,
    testflight: job.testflight,
    versionLabel: job.versionLabel,
    queuedBy: job.queuedBy,
    status: job.status as 'done' | 'failed',
    warnings: job.warnings,
    error: job.error,
    sizeBytes: job.fileSizeBytes,
    source: job.source,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt ?? Date.now(),
    deviceId: job.deviceId,
    ipaMetadata: job.ipaMetadata,
    ipaInfoPlist: job.ipaInfoPlist,
    artifactId: job.artifactId,
    sha256: job.sha256,
    timeline: job.timeline,
    attempt: job.attempt,
    retryCount: job.retryCount,
    deadlineAt: job.deadlineAt,
    deadlineExceeded: job.deadlineExceeded,
    failureClass: job.failureClass,
  };
}

export function cancelQueuedJob(id: string, cancelledBy: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued') return false;

  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
  clearQueuedDeadline(id);

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
  runningJobControllers.get(id)?.abort(new Error(`cancelled by ${cancelledBy}`));
  terminateJobProcess(job);
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

export function prioritizeQueuedJob(id: string, projectId?: string): boolean {
  const job = jobs.get(id);
  if (!job || job.status !== 'queued' || (projectId && (job.projectId ?? DEFAULT_PROJECT_ID) !== projectId)) return false;

  const targetProjectId = projectId ?? job.projectId ?? DEFAULT_PROJECT_ID;
  const scopedQueue = queue.filter((jobId) => (jobs.get(jobId)?.projectId ?? DEFAULT_PROJECT_ID) === targetProjectId);
  const idx = scopedQueue.indexOf(id);
  if (idx <= 0) return idx === 0;

  const reordered = [id, ...scopedQueue.filter((jobId) => jobId !== id)];
  let scopedIndex = 0;
  const nextQueue = queue.map((jobId) => (jobs.get(jobId)?.projectId ?? DEFAULT_PROJECT_ID) === targetProjectId ? reordered[scopedIndex++]! : jobId);
  queue.length = 0;
  queue.push(...nextQueue);
  log.info('job bumped to front of queue', { jobId: id, bundleId: job.bundleId });
  emitJobsChanged();
  return true;
}

export function reorderQueue(orderedIds: string[], projectId?: string): boolean {
  const known = new Set(queue.filter((id) => !projectId || (jobs.get(id)?.projectId ?? DEFAULT_PROJECT_ID) === projectId));
  const requested = [...new Set(orderedIds.filter((id) => known.has(id)))];
  if (requested.length === 0) return false;

  const requestedSet = new Set(requested);
  const scopedRemainder = queue.filter((id) => known.has(id) && !requestedSet.has(id));
  const scopedOrder = [...requested, ...scopedRemainder];
  let scopedIndex = 0;
  const next = projectId
    ? queue.map((id) => known.has(id) ? scopedOrder[scopedIndex++]! : id)
    : [...scopedOrder];

  const changed = next.some((id, i) => id !== queue[i]);
  if (!changed) return false;

  queue.length = 0;
  queue.push(...next);
  log.info('queue manually reordered', { orderedIds: requested });
  emitJobsChanged();
  return true;
}

export function isJobDispatchable(job: Pick<Job, 'preferredDeviceId'>, device: Pick<DeviceRecord, 'id'>): boolean {
  if (job.preferredDeviceId && job.preferredDeviceId !== device.id) return false;
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

function takeNextDispatchableJobId(device: DeviceRecord): string | undefined {
  const cap = config.userConcurrencyCap;
  for (let i = 0; i < queue.length; i++) {
    const job = jobs.get(queue[i]);
    if (!job || !isJobDispatchable(job, device)) continue;
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
  expireOverdueQueuedJobs();
  if (!acceptingJobs) return;
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  if (devices.length === 0) return;
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];

  const rankedDevices = [...devices].sort((a, b) => deviceScore(b, primary) - deviceScore(a, primary));
  for (const device of rankedDevices) {
    if (busyDeviceIds.has(device.id)) continue;
    const jobId = takeNextDispatchableJobId(device);
    if (!jobId) continue;
    const job = jobs.get(jobId);
    if (!job) continue;

    busyDeviceIds.add(device.id);
    const run = withCorrelation({ correlationId: job.correlationId ?? job.id }, () => runOneJob(device, job));
    runningJobs.set(job.id, run);
    void run.finally(() => {
      runningJobs.delete(job.id);
      busyDeviceIds.delete(device.id);
      pumpWorkers();
    });
  }
}

async function runOneJob(device: DeviceRecord, job: Job): Promise<void> {
  clearQueuedDeadline(job.id);
  job.status = 'running';
  const controller = new AbortController();
  runningJobControllers.set(job.id, controller);
  job.startedAt = Date.now();
  job.deviceId = device.id;
  job.attempt = (job.retryCount ?? 0) + 1;
  recordJobStarted(job, job.startedAt);
  appendJobTimelineEvent(job, `Started on ${device.name}`, 'running', job.startedAt);
  log.info('job started', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id });
  recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: `Started ${job.testflight ? 'TestFlight' : 'App Store'} decrypt` });
  persistActiveJobs();
  emitJobsChanged();

  try {
    const remainingMs = job.deadlineAt === undefined ? undefined : Math.max(1, job.deadlineAt - Date.now());
    await runWithJobDeadline(
      (signal) => runDecrypt(job, device, signal),
      controller,
      {
        timeoutMs: remainingMs,
        graceMs: config.jobProcessGraceSeconds * 1000,
        onDeadline: () => {
          job.deadlineExceeded = true;
          job.progress = 'job deadline exceeded';
          emitJobsChanged();
        },
        forceStop: () => terminateChildProcess(job.childProcess, 'SIGKILL'),
        onForceStopTimeout: (error) => {
          job.progress = 'deadline exceeded; waiting for device work to stop';
          appendJobTimelineEvent(job, job.progress, 'running');
          log.error('device work did not stop after force-kill; keeping the device worker reserved', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: error ? String(error) : undefined });
          emitJobsChanged();
        },
      },
    ).finally(() => {
      if (runningJobControllers.get(job.id) === controller) runningJobControllers.delete(job.id);
    });
    job.status = 'done';
    job.finishedAt = Date.now();
    incrementMetric('jobs_completed_total', { source: job.source });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { source: job.source });
    appendJobTimelineEvent(job, 'Finished', 'done', job.finishedAt);
    log.info('job done', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, sizeBytes: job.fileSizeBytes });
    recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt completed' });
    persistDoneJobs();
    persistActiveJobs();
  } catch (err) {
    let message = job.cancelledBy ? `cancelled by ${job.cancelledBy}` : err instanceof Error ? err.message : String(err);
    if (job.filePath?.startsWith(`${config.artifactDir}/.staging/`)) {
      await rm(job.filePath, { force: true }).catch(() => {});
      job.filePath = undefined;
    }
    job.failureClass = classifyJobFailure(message);
    const remainingDeadlineMs = job.deadlineAt === undefined ? Number.POSITIVE_INFINITY : job.deadlineAt - Date.now();
    const canRetry = !job.cancelledBy
      && !job.deadlineExceeded
      && remainingDeadlineMs > 0
      && (job.retryCount ?? 0) < config.jobMaxRetries
      && ['device_transport', 'app_store', 'testflight', 'network', 'storage'].includes(job.failureClass);
    if (canRetry) {
      job.progress = 'retrying after a transient failure…';
      appendJobTimelineEvent(job, job.progress, 'running');
      log.warn('job failed, retrying once after backoff', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: message });
      persistActiveJobs();
      emitJobsChanged();
      runningJobControllers.set(job.id, controller);
      try {
        await delayWithSignal(Math.min(RETRY_BACKOFF_MS, remainingDeadlineMs), controller.signal);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      } finally {
        if (runningJobControllers.get(job.id) === controller) runningJobControllers.delete(job.id);
      }
      if (job.cancelledBy) {
        job.status = 'failed';
        job.finishedAt = Date.now();
        job.error = `cancelled by ${job.cancelledBy}`;
        job.failureClass = classifyJobFailure(job.error);
        appendJobTimelineEvent(job, job.error, 'failed', job.finishedAt);
        log.info('job cancelled during retry backoff', { jobId: job.id, bundleId: job.bundleId, cancelledBy: job.cancelledBy });
        persistActiveJobs();
        recordJobHistory(toHistoryEntry(job));
        emitJobsChanged();
        settle(job);
        return;
      }
      if (job.deadlineAt !== undefined && Date.now() >= job.deadlineAt) {
        job.deadlineExceeded = true;
        job.progress = 'job deadline exceeded';
        message = job.progress;
      } else if (!controller.signal.aborted) {
        job.retryCount = (job.retryCount ?? 0) + 1;
        return runOneJob(device, job);
      }
    }

    job.failureClass = classifyJobFailure(message);
    job.status = 'failed';
    job.finishedAt = Date.now();
    incrementMetric('jobs_failed_total', { source: job.source, failureClass: job.failureClass });
    observeMetric('job_duration_ms', Math.max(0, job.finishedAt - (job.startedAt ?? job.createdAt)), { source: job.source });
    job.error = message;
    appendJobTimelineEvent(job, `Failed: ${message}`, 'failed', job.finishedAt);
    log.error('job failed', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, error: job.error, retried: (job.retryCount ?? 0) > 0 });
    recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypt failed' });
    persistActiveJobs();
  }

  const completedArtifact = job.status === 'done' && job.artifactId ? getArtifactById(job.artifactId) : undefined;
  const downloadUrl = completedArtifact ? buildDashboardArtifactFileUrl(completedArtifact.id) : undefined;

  recordJobHistory(toHistoryEntry(job));
  emitJobsChanged();

  if (job.queuedBy) {
    const prefs = getUserPrefs(job.queuedBy);
    const label = job.versionLabel ? `${job.bundleId} (${job.versionLabel})` : job.bundleId;
    const hasWarnings = job.status === 'done' && (job.warnings?.length ?? 0) > 0;
    const title = job.status === 'done'
      ? hasWarnings ? 'Decrypt finished with warnings' : 'Decrypt finished'
      : 'Decrypt failed';
    const body = job.status === 'done'
      ? `${downloadUrl ? `${label} is ready to download.` : `${label} finished, but its artifact is unavailable.`}${hasWarnings ? ` Completed with warnings: ${job.warnings?.join(' ')}` : ''}`
      : `${label} failed: ${job.error ?? 'unknown error'}`;

    const shouldPush = job.status === 'done' ? (prefs.pushOnSuccess ?? true) : (prefs.pushOnFailure ?? true);
    if (shouldPush) {
      void sendPushToUser(job.queuedBy, {
        title,
        body,
        url: downloadUrl ?? `/?job=${encodeURIComponent(job.id)}`,
        actions: downloadUrl
          ? [{ action: 'download', title: 'Download' }]
          : [{ action: 'open-job', title: 'Open job' }],
      });
    }

    const shouldMail = job.status === 'done' ? (prefs.emailOnSuccess ?? false) : (prefs.emailOnFailure ?? false);
    if (shouldMail) void sendMailToUser(job.queuedBy, {
      subject: title,
      text: downloadUrl ? `${body}\n\nDownload: ${downloadUrl}` : body,
    });
  }

  settle(job);
}

async function cleanupJob(job: Job): Promise<void> {
  if (job.filePath && !job.artifactId && !getArtifactForJob(job)) {
    await rm(job.filePath, { force: true }).catch((err: unknown) => {
      log.warn('failed to remove job file', { jobId: job.id, error: String(err) });
    });
  }
  jobs.delete(job.id);
  log.info('job cleaned up', { jobId: job.id, bundleId: job.bundleId });
  persistDoneJobs();
}

export async function reclaimJobFile(job: Job): Promise<void> {
  if (job.artifactId || getArtifactForJob(job)) return;
  job.downloadedAt = Date.now();
  await cleanupJob(job);
}

async function reclaimAndMaybeUninstall(job: Job): Promise<void> {
  const { bundleId, status } = job;
  await cleanupJob(job);
  if (status === 'done' && !isBundleWatched(bundleId)) {
    await uninstallFromDevice(bundleId, job.deviceId ? getDevice(job.deviceId) : undefined).catch((err: unknown) => {
      log.warn('device uninstall during sweep failed', { bundleId, error: String(err) });
    });
  }
}

let jobSweepTimer: NodeJS.Timeout | undefined;

function queueSloTarget(): { targetMs: number; historicalP95Ms: number | null } {
  const durations = getAllJobHistory()
    .filter((job) => job.status === 'done' && job.startedAt && job.finishedAt > job.startedAt)
    .map((job) => job.finishedAt - (job.startedAt as number))
    .sort((a, b) => a - b);
  const historicalP95Ms = durations.length === 0 ? null : durations[Math.ceil(durations.length * 0.95) - 1];
  return { targetMs: historicalP95Ms ?? config.queueSloMinutes * 60_000, historicalP95Ms };
}

function queueSloBreached(job: Job, now: number, targetMs: number, historicalP95Ms: number | null): boolean {
  const waitedMs = now - job.createdAt;
  const queue = job.status === 'queued' ? getQueueInfo(job.id) : undefined;
  const predictedStartMs = queue && historicalP95Ms !== null ? Math.max(0, queue.position - 1) * historicalP95Ms : null;
  const predictedCompletionMs = predictedStartMs === null || historicalP95Ms === null ? null : predictedStartMs + historicalP95Ms;
  return waitedMs > targetMs || (predictedCompletionMs !== null && waitedMs + predictedCompletionMs > targetMs);
}

async function monitorQueueSlo(): Promise<void> {
  const active = getActiveJobs();
  const activeIds = new Set(active.map((job) => job.id));
  for (const jobId of queueSloNotified) if (!activeIds.has(jobId)) queueSloNotified.delete(jobId);
  const { targetMs, historicalP95Ms } = queueSloTarget();
  const now = Date.now();
  for (const job of active) {
    if (!queueSloBreached(job, now, targetMs, historicalP95Ms) || queueSloNotified.has(job.id)) continue;
    queueSloNotified.add(job.id);
    void notify('queueSloBreach', {
      title: 'Queue service objective breached',
      description: `${job.bundleId} has waited ${Math.max(0, Math.round((now - job.createdAt) / 60_000))} minutes and is outside the ${Math.max(1, Math.round(targetMs / 60_000))}-minute queue objective.`,
      color: EMBED_COLOR.warn,
      fields: [
        { name: 'Job', value: job.id, inline: true },
        { name: 'Status', value: job.status, inline: true },
        { name: 'Queue reason', value: getQueueReason(job) ?? 'assigned and running', inline: false },
      ],
    }).catch((error) => log.warn('queue SLO notification failed', { jobId: job.id, error: String(error) }));
  }
}

export function startJobSweeper(): void {
  pumpWorkers();
  const intervalMs = 60_000;
  jobSweepTimer ??= setInterval(() => {
    void monitorQueueSlo();
    const now = Date.now();
    const retentionMs = config.jobRetentionMinutes * 60_000;

    for (const job of jobs.values()) {

      const finishedAt = job.finishedAt ?? job.createdAt;
      if ((job.status === 'done' || job.status === 'failed') && now - finishedAt > retentionMs) {
        void reclaimAndMaybeUninstall(job);
      }
    }
  }, intervalMs).unref();
}

export function stopJobSweeper(): void {
  if (jobSweepTimer) clearInterval(jobSweepTimer);
  jobSweepTimer = undefined;
}

export function stopAcceptingJobs(): void {
  acceptingJobs = false;
}

export async function shutdownJobs(timeoutMs = 15_000): Promise<void> {
  stopJobSweeper();
  stopAcceptingJobs();
  const now = Date.now();
  for (const jobId of queue.splice(0)) {
    clearQueuedDeadline(jobId);
    const job = jobs.get(jobId);
    if (!job || job.status !== 'queued') continue;
    job.status = 'failed';
    job.error = 'dkrypt is shutting down';
    job.finishedAt = now;
    appendJobTimelineEvent(job, job.error, 'failed', now);
    recordJobHistory(toHistoryEntry(job));
    settle(job);
  }
  for (const jobId of [...queuedDeadlineTimers.keys()]) clearQueuedDeadline(jobId);
  for (const job of jobs.values()) {
    if (job.status === 'running') {
      runningJobControllers.get(job.id)?.abort(new Error('dkrypt is shutting down'));
      terminateJobProcess(job);
    }
  }
  persistActiveJobs();
  const runs = [...runningJobs.values()];
  if (runs.length > 0) await Promise.race([Promise.allSettled(runs), sleep(timeoutMs)]);
  for (const job of jobs.values()) {
    if (job.status === 'running') terminateChildProcess(job.childProcess, 'SIGKILL');
  }
  persistActiveJobs();
  if (runs.length === 0) {
    closePersistedJobs();
    return;
  }
  await Promise.race([Promise.allSettled(runs), sleep(1_000)]);
  if ([...runningJobs.keys()].length === 0) closePersistedJobs();
}
