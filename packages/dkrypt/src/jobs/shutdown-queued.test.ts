import { expect, test } from 'bun:test';
import { getJobHistoryEntryById } from '#store/state.js';
import { loadPersistedJobs } from './repository.js';

const { closeJobStore, enqueueDecryptJob, getJob, recoverPersistedActiveJobs, shutdownJobs } = await import('./store.js');

test('shutdown preserves queued jobs for the replacement process', async () => {
  const job = enqueueDecryptJob(`com.test.shutdown-queued-${crypto.randomUUID()}`, 'manual', {
    minimumOsVersion: '999.0',
  });

  try {
    expect(job.status).toBe('queued');

    const shutdown = await shutdownJobs(1000);
    await shutdown.completion;

    expect(getJob(job.id)?.status).toBe('queued');
    expect(getJobHistoryEntryById(job.id)).toBeUndefined();

    const persisted = loadPersistedJobs().find((entry) => entry.id === job.id);
    expect(persisted?.status).toBe('queued');
    expect(recoverPersistedActiveJobs([{ ...persisted!, waiters: [] }]).queued.map((entry) => entry.id)).toContain(job.id);
  } finally {
    closeJobStore();
  }
});

test('startup recovers a shutdown-marked running job as queued instead of failed', () => {
  const saved = {
    id: `shutdown-recovery-${crypto.randomUUID()}`,
    correlationId: crypto.randomUUID(),
    projectId: 'default',
    bundleId: 'com.test.shutdown-recovery',
    source: 'manual' as const,
    priority: 0,
    status: 'running' as const,
    progress: 'decrypting',
    createdAt: Date.now(),
    startedAt: Date.now(),
    deadlineAt: Date.now() - 1,
    shutdownRecoveryPending: true,
    waiters: [],
  };

  const recovered = recoverPersistedActiveJobs([saved]);

  expect(recovered.queued).toMatchObject([{ id: saved.id, status: 'queued', progress: 'queued after graceful shutdown' }]);
  expect(recovered.queued[0]?.deadlineAt).toBeGreaterThan(Date.now());
  expect(recovered.interrupted).toEqual([]);
});
