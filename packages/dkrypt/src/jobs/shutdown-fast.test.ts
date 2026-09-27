import { mock, expect, test } from 'bun:test';
import { createDevice, deleteDevice, getJobHistoryEntryById } from '#store/state.js';
import type { Job } from '#jobs/types.js';

let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('./runner.js', () => ({
  runDecrypt: (_job: Job, _device: unknown, signal?: AbortSignal) => {
    markRunnerStarted?.();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  },
}));

const { closeJobStore, enqueueDecryptJob, shutdownJobs, waitForJob } = await import('./store.js');

test('shutdown completes a fast job drain after its final persistence', async () => {
  const device = createDevice({ name: `shutdown-fast-device-${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'tests');
  const job = enqueueDecryptJob(`com.test.shutdown-fast-${crypto.randomUUID()}`, 'manual');

  try {
    await runnerStarted;
    const shutdown = await shutdownJobs(1000);
    expect(shutdown.drained).toBe(true);
    await shutdown.completion;
    await expect(waitForJob(job, 1000)).resolves.toMatchObject({ status: 'failed' });
    expect(getJobHistoryEntryById(job.id)).toMatchObject({ id: job.id, status: 'failed' });
  } finally {
    closeJobStore();
    deleteDevice(device.id, 'tests');
  }
});
