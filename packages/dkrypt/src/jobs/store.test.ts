import { describe, expect, mock, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

mock.module('./runner.js', () => ({
  runDecrypt: () => new Promise<void>(() => {}),
}));

const { cancelJob, cancelQueuedJob, enqueueDecryptJob, getActiveJobs, getJob, getQueueInfo, getQueueReason, reclaimJobFile, recoverPersistedActiveJobs } = await import('./store.js');

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

  test('reuses a completed exact build while its IPA still exists', async () => {
    const outputDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-cache-'));
    const outputPath = path.join(outputDir, 'app.ipa');
    await writeFile(outputPath, 'ipa');
    const completed = enqueueDecryptJob('com.test.cached', 'manual', '123');
    completed.status = 'done';
    completed.filePath = outputPath;
    completed.finishedAt = Date.now();

    const retry = enqueueDecryptJob('com.test.cached', 'manual', '123');
    expect(retry.id).toBe(completed.id);
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
  test('accepts cancellation while an App Store install is running', () => {
    const running = getActiveJobs().find((job) => job.status === 'running');
    expect(running).toBeDefined();
    if (!running) return;
    expect(running.status).toBe('running');
    expect(running.childProcess).toBeUndefined();

    expect(cancelJob(running.id, 'tester')).toBe(true);
    expect(getJob(running.id)?.cancelledBy).toBe('tester');
  });

  test('falls back to killing a running job process when it is not queued', () => {
    const running = enqueueDecryptJob('com.test.running', 'manual');
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
