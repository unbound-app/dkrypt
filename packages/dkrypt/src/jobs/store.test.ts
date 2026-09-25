import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import { artifactKeyForJob, promoteArtifact } from '#artifacts.js';
import { createDevice, createProject, deleteDevice } from '#store/state.js';
import type { Job } from '#jobs/types.js';

let retryDeadlineAttempts = 0;

mock.module('./runner.js', () => ({
  runDecrypt: (job: Job, _device: unknown, signal?: AbortSignal) => {
    if (job.bundleId === 'com.test.retry-deadline' || job.bundleId === 'com.test.retry-cancel') {
      retryDeadlineAttempts += 1;
      if (job.bundleId === 'com.test.retry-deadline') job.deadlineAt = Date.now() + 75;
      return Promise.reject(new Error('network unavailable'));
    }
    return new Promise<void>((_resolve, reject) => {
      const abort = () => reject(signal?.reason instanceof Error ? signal.reason : new Error('operation aborted'));
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  },
}));

const { cancelJob, cancelQueuedJob, enqueueDecryptJob, getActiveJobs, getJob, getQueueInfo, getQueueReason, isJobDispatchable, prioritizeQueuedJob, reclaimJobFile, recoverPersistedActiveJobs, reorderQueue, waitForJob } = await import('./store.js');

let testDeviceId = '';

beforeAll(() => {
  testDeviceId = createDevice({ name: 'job-test-device', transport: 'wifi', host: '127.0.0.1' }, 'tests').id;
});

afterAll(() => {
  if (testDeviceId) deleteDevice(testDeviceId, 'tests');
});

async function clearActiveTestJobs(): Promise<void> {
  const active = getActiveJobs();
  for (const job of active) {
    if (job.status === 'queued') cancelQueuedJob(job.id, 'test reset');
    else cancelJob(job.id, 'test reset');
  }
  await Promise.all(active.map((job) => waitForJob(job, 1_000)));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('recoverPersistedActiveJobs', () => {
  test('keeps queued jobs and records a running job as interrupted after a restart', () => {
    const base = {
      bundleId: 'com.test.restart',
      source: 'scheduler' as const,
      priority: 0,
      progress: 'decrypting',
      createdAt: 1,
      waiters: [],
    };
    const { queued, interrupted } = recoverPersistedActiveJobs([
      { ...base, id: 'queued', status: 'queued' },
      { ...base, id: 'running', status: 'running', startedAt: 2 },
    ], 3);

    expect(queued.map((job) => job.id)).toEqual(['queued']);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({
      id: 'running',
      status: 'failed',
      error: 'interrupted by dkrypt restart',
      finishedAt: 3,
    });
  });
});

describe('enqueueDecryptJob', () => {
  test('allows TestFlight jobs on any enabled device', () => {
    const job = { preferredDeviceId: undefined } as Pick<Job, 'preferredDeviceId'>;

    expect(isJobDispatchable(job, { id: 'secondary-device' })).toBeTrue();
  });

  test('scheduler jumps queued dashboard jobs, dedupes same bundle, never overtakes a running job', () => {
    const running = enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');

    const queuedManual = enqueueDecryptJob('com.test.manual', 'manual');
    const queuedManualAgain = enqueueDecryptJob('com.test.manual', 'manual');
    expect(queuedManualAgain.id).toBe(queuedManual.id);

    const queuedScheduler = enqueueDecryptJob('com.test.scheduler', 'scheduler');

    const runningPos = getQueueInfo(running.id);
    const manualPos = getQueueInfo(queuedManual.id);
    const schedulerPos = getQueueInfo(queuedScheduler.id);

    expect(runningPos?.position).toBe(1);
    expect(schedulerPos?.position).toBeLessThan(manualPos!.position);
    expect(getActiveJobs().map((j) => j.id)).toContain(running.id);
  });

  test('labels an unpinned App Store job as the current release', () => {
    const job = enqueueDecryptJob('com.test.current-release', 'manual');
    expect(job.versionLabel).toBe('Current App Store release');
  });

  test('explains why a queued job is waiting', () => {
    const job = enqueueDecryptJob(`com.test.queue-reason-${crypto.randomUUID()}`, 'manual');
    expect(job.status).toBe('queued');
    expect(getQueueReason(job)).toMatch(/^Waiting /);
  });

  test('fails a queued job when its end-to-end deadline expires before dispatch', async () => {
    const originalDeadline = config.jobMaxWaitSeconds;
    config.jobMaxWaitSeconds = 0;

    try {
      const job = enqueueDecryptJob(`com.test.expired-${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, 'missing-device');
      await expect(waitForJob(job, 100)).resolves.toMatchObject({
        status: 'failed',
        deadlineExceeded: true,
        error: 'job deadline exceeded while waiting in the queue',
      });
    } finally {
      config.jobMaxWaitSeconds = originalDeadline;
    }
  });

  test('reuses a completed exact build while its IPA still exists', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-cache-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const bundleId = `com.test.cached.${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key: artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId: '123' }),
      bundleId,
      channel: 'appstore',
      externalVersionId: '123',
      stagingPath: outputPath,
    });
    const completed = enqueueDecryptJob(bundleId, 'manual', '123');

    const retry = enqueueDecryptJob(bundleId, 'manual', '123');
    expect(completed.status).toBe('done');
    expect(completed.artifactId).toBe(artifact.id);
    expect(retry.status).toBe('done');
    expect(retry.artifactId).toBe(artifact.id);
  });

  test('keeps active-job deduplication within a project and links shared cache hits', async () => {
    const bundleId = `com.test.project-cache.${crypto.randomUUID()}`;
    const projectA = createProject({ name: `Cache project A ${crypto.randomUUID()}` }, 'root').project!.id;
    const projectB = createProject({ name: `Cache project B ${crypto.randomUUID()}` }, 'root').project!.id;
    const firstProjectJob = enqueueDecryptJob(bundleId, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectA);
    const duplicateFirstProjectJob = enqueueDecryptJob(bundleId, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectA);
    const secondProjectJob = enqueueDecryptJob(bundleId, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectB);

    expect(firstProjectJob.id).toBe(duplicateFirstProjectJob.id);
    expect(secondProjectJob.id).not.toBe(firstProjectJob.id);
    expect(firstProjectJob.projectId).toBe(projectA);
    expect(secondProjectJob.projectId).toBe(projectB);

    cancelQueuedJob(firstProjectJob.id, 'project test cleanup');
    cancelQueuedJob(secondProjectJob.id, 'project test cleanup');

    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-project-cache-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const artifact = await promoteArtifact({
      key: artifactKeyForJob({ id: 'lookup', bundleId, externalVersionId: 'project-cache-build' }),
      bundleId,
      channel: 'appstore',
      externalVersionId: 'project-cache-build',
      projectId: projectA,
      stagingPath: outputPath,
    });
    const shared = enqueueDecryptJob(bundleId, 'manual', 'project-cache-build', undefined, undefined, undefined, 0, undefined, undefined, projectB);

    expect(shared).toMatchObject({ status: 'done', projectId: projectB, artifactId: artifact.id, cacheHit: true });
    expect(artifact.projectIds).toContain(projectB);
  });

  test('enforces a project concurrent-job quota without affecting another project', async () => {
    const project = createProject({ name: `Concurrency quota ${crypto.randomUUID()}`, maxConcurrentJobs: 1 }, 'root').project!;
    const first = enqueueDecryptJob(`com.test.project-quota.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, project.id);

    expect(() => enqueueDecryptJob(`com.test.project-quota.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, project.id)).toThrow('project concurrency limit reached');
    const otherProject = createProject({ name: `Independent quota ${crypto.randomUUID()}` }, 'root').project!;
    const independent = enqueueDecryptJob(`com.test.project-quota.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, otherProject.id);
    expect(independent.projectId).toBe(otherProject.id);

    cancelQueuedJob(first.id, 'project quota test cleanup');
    cancelQueuedJob(independent.id, 'project quota test cleanup');
  });

  test('reclaims a completed job file without an artifact exception', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-job-retention-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const job = enqueueDecryptJob('com.test.scheduler-share', 'scheduler');
    job.status = 'done';
    job.filePath = outputPath;
    job.finishedAt = Date.now();
    await reclaimJobFile(job);
    expect(getJob(job.id)).toBeUndefined();
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe('cancelQueuedJob', () => {
  test('removes a queued job from the queue and marks it failed, but not a running one', () => {

    const running = enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');
    const queued = enqueueDecryptJob('com.test.cancel-queued', 'manual');

    expect(cancelQueuedJob(running.id, 'tester')).toBe(false);
    expect(getActiveJobs().map((j) => j.id)).toContain(running.id);

    expect(cancelQueuedJob(queued.id, 'tester')).toBe(true);
    expect(getActiveJobs().map((j) => j.id)).not.toContain(queued.id);
    expect(getJob(queued.id)?.status).toBe('failed');
    expect(getJob(queued.id)?.error).toBe('cancelled by tester');

    expect(cancelQueuedJob('does-not-exist', 'tester')).toBe(false);
  });
});

describe('cancelJob', () => {
  test('accepts cancellation while an App Store install is running', async () => {
    const running = getActiveJobs().find((job) => job.status === 'running');
    expect(running).toBeDefined();
    if (!running) return;
    expect(running.status).toBe('running');
    expect(running.childProcess).toBeUndefined();

    const completion = waitForJob(running, 1_000);
    expect(cancelJob(running.id, 'tester')).toBe(true);
    expect(getJob(running.id)?.cancelledBy).toBe('tester');
    await expect(completion).resolves.toMatchObject({ status: 'failed', error: 'cancelled by tester' });
  });

  test('falls back to killing a running job process when it is not queued', () => {
    const running = getActiveJobs().find((job) => job.status === 'running') ?? enqueueDecryptJob('com.test.running', 'manual');
    expect(running.status).toBe('running');

    let killedWith: string | undefined;
    const job = getJob(running.id)!;
    job.cancelledBy = undefined;
    job.childProcess = { kill: (signal: string) => (killedWith = signal) } as unknown as typeof job.childProcess;

    expect(cancelJob(running.id, 'tester')).toBe(true);
    expect(killedWith).toBe('SIGTERM');
    expect(getJob(running.id)?.cancelledBy).toBe('tester');

    expect(cancelJob('does-not-exist', 'tester')).toBe(false);
  });
});

test('does not let transient retry backoff extend the end-to-end job deadline', async () => {
  const originalRetries = config.jobMaxRetries;
  retryDeadlineAttempts = 0;
  config.jobMaxRetries = 1;

  try {
    await clearActiveTestJobs();
    const job = enqueueDecryptJob('com.test.retry-deadline', 'manual');
    const finished = await waitForJob(job, 1_000);

    expect(finished).toMatchObject({
      status: 'failed',
      deadlineExceeded: true,
      error: 'job deadline exceeded',
      attempt: 1,
    });
    expect(finished?.retryCount).toBeUndefined();
    expect(retryDeadlineAttempts).toBe(1);
  } finally {
    config.jobMaxRetries = originalRetries;
  }
});

test('cancels a running job while it is waiting for transient retry backoff', async () => {
  const originalRetries = config.jobMaxRetries;
  retryDeadlineAttempts = 0;
  config.jobMaxRetries = 1;

  try {
    await clearActiveTestJobs();
    const job = enqueueDecryptJob('com.test.retry-cancel', 'manual');
    for (let attempt = 0; attempt < 100 && job.progress !== 'retrying after a transient failure…'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(job.progress).toBe('retrying after a transient failure…');
    expect(cancelJob(job.id, 'tester')).toBe(true);
    await expect(waitForJob(job, 250)).resolves.toMatchObject({
      status: 'failed',
      error: 'cancelled by tester',
      failureClass: 'cancelled',
    });
    expect(retryDeadlineAttempts).toBe(1);
  } finally {
    config.jobMaxRetries = originalRetries;
  }
});

test('reordering and prioritizing a project queue leaves other project positions intact', async () => {
  await clearActiveTestJobs();
  const blocker = enqueueDecryptJob(`com.test.queue-blocker.${crypto.randomUUID()}`, 'manual');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const projectA = createProject({ name: `Queue project A ${crypto.randomUUID()}` }, 'root').project!.id;
  const projectB = createProject({ name: `Queue project B ${crypto.randomUUID()}` }, 'root').project!.id;
  const firstA = enqueueDecryptJob(`com.test.queue-a1.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectA);
  const firstB = enqueueDecryptJob(`com.test.queue-b1.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectB);
  const secondA = enqueueDecryptJob(`com.test.queue-a2.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectA);
  const secondB = enqueueDecryptJob(`com.test.queue-b2.${crypto.randomUUID()}`, 'manual', undefined, undefined, undefined, undefined, 0, undefined, undefined, projectB);

  try {
    expect(blocker.status).toBe('running');
    const firstBPosition = getQueueInfo(firstB.id)?.position;
    const secondBPosition = getQueueInfo(secondB.id)?.position;
    expect(reorderQueue([secondA.id, firstA.id], projectA)).toBe(true);
    expect(getQueueInfo(secondA.id)!.position).toBeLessThan(firstBPosition!);
    expect(firstBPosition).toBe(getQueueInfo(firstB.id)?.position);
    expect(getQueueInfo(firstB.id)!.position).toBeLessThan(getQueueInfo(firstA.id)!.position);
    expect(getQueueInfo(firstA.id)!.position).toBeLessThan(secondBPosition!);
    expect(secondBPosition).toBe(getQueueInfo(secondB.id)?.position);
    expect(prioritizeQueuedJob(firstA.id, projectA)).toBe(true);
    expect(getQueueInfo(firstA.id)!.position).toBeLessThan(firstBPosition!);
    expect(firstBPosition).toBe(getQueueInfo(firstB.id)?.position);
    expect(getQueueInfo(firstB.id)!.position).toBeLessThan(getQueueInfo(secondA.id)!.position);
    expect(getQueueInfo(secondA.id)!.position).toBeLessThan(secondBPosition!);
    expect(secondBPosition).toBe(getQueueInfo(secondB.id)?.position);
    expect(prioritizeQueuedJob(firstB.id, projectA)).toBe(false);
  } finally {
    await clearActiveTestJobs();
  }
});
