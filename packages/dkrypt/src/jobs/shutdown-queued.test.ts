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
