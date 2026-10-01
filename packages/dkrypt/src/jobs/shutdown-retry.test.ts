import { mock, expect, test } from 'bun:test';
import { createDevice, deleteDevice, getJobHistoryEntryById } from '#store/state.js';

let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('./runner.js', () => ({
  runDecrypt: () => {
    markRunnerStarted?.();
    return Promise.reject(new Error('network unavailable'));
  },
}));

const { closeJobStore, enqueueDecryptJob, getJob, shutdownJobs } = await import('./store.js');

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('shutdown requeues a job interrupted during transient retry backoff', async () => {
  const device = createDevice({ name: `shutdown-retry-${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'tests');
  const job = enqueueDecryptJob(`com.test.shutdown-retry-${crypto.randomUUID()}`, 'manual');

  try {
    await runnerStarted;
    for (let attempt = 0; attempt < 100 && !getJob(job.id)?.progress.startsWith('retrying'); attempt += 1) {
      await delay(1);
    }
    expect(getJob(job.id)?.progress).toContain('retrying');

    const shutdown = await shutdownJobs(1);
    expect(shutdown.drained).toBe(true);
    await shutdown.completion;
    expect(getJob(job.id)).toMatchObject({ status: 'queued', progress: 'queued after graceful shutdown' });
    expect(getJobHistoryEntryById(job.id)).toBeUndefined();
  } finally {
    closeJobStore();
    deleteDevice(device.id, 'tests');
  }
});
