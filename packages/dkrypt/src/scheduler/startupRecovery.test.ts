import { afterEach, expect, test } from 'bun:test';
import { config } from '#config.js';
import { isTickInProgress, startScheduler, stopScheduler } from '#scheduler/index.js';
import { createWatch, deleteWatch, getEffectiveWatches, getSchedulerRunHistory, markWatchScheduleRun } from '#store/state.js';

const originalFetch = globalThis.fetch;
const originalGitHubToken = config.ghToken;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSchedulerRuns(watchId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (getSchedulerRunHistory(20, watchId).length >= expected) return;
    await wait(10);
  }
  throw new Error(`scheduler did not record ${expected} run(s) for ${watchId}`);
}

async function waitForSchedulerToIdle(watchId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!isTickInProgress(watchId)) return;
    await wait(10);
  }
  throw new Error(`scheduler remained active for ${watchId}`);
}

afterEach(() => {
  stopScheduler();
  globalThis.fetch = originalFetch;
  config.ghToken = originalGitHubToken;
});

test('budget-deferred runOnce checks remain recoverable after scheduler restart', async () => {
  const created = createWatch({
    bundleId: `com.dkrypt.scheduler-recovery.${crypto.randomUUID()}`,
    repo: 'owner/repo',
    ghWorkflowFile: 'release.yml',
    pollCron: '0 * * * *',
    timezone: 'UTC',
    missedRunPolicy: 'runOnce',
  }, 'scheduler recovery test');
  expect(created.watch).toBeDefined();
  const watch = created.watch!;
  const missedCheckpoint = Date.now() - 3 * 60 * 60 * 1000;
  markWatchScheduleRun(watch.id, missedCheckpoint);
  config.ghToken = 'scheduler-recovery-test-token';
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    if (!String(input).endsWith('/rate_limit')) throw new Error(`unexpected GitHub request ${String(input)}`);
    return Response.json({ resources: { core: { limit: 5_000, remaining: 100, reset: Math.floor((Date.now() + 60_000) / 1000) } } });
  }) as typeof fetch;

  try {
    startScheduler();
    await waitForSchedulerRuns(watch.id, 1);
    await waitForSchedulerToIdle(watch.id);
    expect(getEffectiveWatches().find((candidate) => candidate.id === watch.id)?.lastScheduledAt).toBe(missedCheckpoint);

    stopScheduler();
    startScheduler();
    await waitForSchedulerRuns(watch.id, 2);
    await waitForSchedulerToIdle(watch.id);
    expect(getEffectiveWatches().find((candidate) => candidate.id === watch.id)?.lastScheduledAt).toBe(missedCheckpoint);
  } finally {
    stopScheduler();
    deleteWatch(watch.id, 'scheduler recovery test');
  }
});
