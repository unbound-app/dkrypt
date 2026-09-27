import { mock, expect, test } from 'bun:test';
import { createDevice, deleteDevice, getJobHistoryEntryById } from '#store/state.js';

let finishOperation: (() => void) | undefined;
let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('./runner.js', () => ({
  runDecrypt: () => {
    markRunnerStarted?.();
    return new Promise<void>((resolve) => { finishOperation = resolve; });
  },
}));

const { enqueueDecryptJob, shutdownJobs, waitForJob } = await import('./store.js');

test('shutdown keeps persistence open until an uncancellable job runner settles', async () => {
  const device = createDevice({ name: `shutdown-device-${crypto.randomUUID()}`, transport: 'wifi', host: '127.0.0.1' }, 'tests');
  const job = enqueueDecryptJob(`com.test.shutdown-${crypto.randomUUID()}`, 'manual');

  try {
    await runnerStarted;
    expect(job.status).toBe('running');
    expect(finishOperation).toBeDefined();

    const shutdown = await shutdownJobs(1);
    expect(shutdown.drained).toBe(false);
    let shutdownFinished = false;
    void shutdown.completion.then(() => { shutdownFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(shutdownFinished).toBe(false);

    finishOperation?.();
    await shutdown.completion;
    await expect(waitForJob(job, 1000)).resolves.toMatchObject({ status: 'done' });
    expect(getJobHistoryEntryById(job.id)).toMatchObject({ id: job.id, status: 'done' });
  } finally {
    finishOperation?.();
    deleteDevice(device.id, 'tests');
  }
});
