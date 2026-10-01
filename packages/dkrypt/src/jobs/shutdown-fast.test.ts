import { mock, expect, test } from 'bun:test';
import { createDevice, deleteDevice, getJobHistoryEntryById } from '#store/state.js';
import type { Job } from '#jobs/types.js';

let finishOperation: (() => void) | undefined;
let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('./runner.js', () => ({
  runDecrypt: (_job: Job, _device: unknown, signal?: AbortSignal) => {
    markRunnerStarted?.();
    return new Promise<void>((resolve, reject) => {
      finishOperation = resolve;
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  },
}));

const { closeJobStore, enqueueDecryptJob, shutdownJobs, waitForJob } = await import('./store.js');

test('shutdown drains a running job that completes before the grace deadline', async () => {
  const device = createDevice({ name: `shutdown-fast-device-${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'tests');
  const job = enqueueDecryptJob(`com.test.shutdown-fast-${crypto.randomUUID()}`, 'manual');

  try {
    await runnerStarted;
    const shutdownPromise = shutdownJobs(1000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishOperation?.();
    const shutdown = await shutdownPromise;
    expect(shutdown.drained).toBe(true);
    await shutdown.completion;
    await expect(waitForJob(job, 1000)).resolves.toMatchObject({ status: 'done' });
    expect(getJobHistoryEntryById(job.id)).toMatchObject({ id: job.id, status: 'done' });
  } finally {
    finishOperation?.();
    closeJobStore();
    deleteDevice(device.id, 'tests');
  }
});
