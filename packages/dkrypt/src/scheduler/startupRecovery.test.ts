import { afterEach, expect, test } from 'bun:test';
import { config } from '#config.js';
import { isTickInProgress, startScheduler, stopScheduler } from '#scheduler/index.js';
import { createWatch, deleteWatch, getEffectiveWatches, getSchedulerRunHistory, getWatchDispatchTargets, markWatchScheduleRun, recordSchedulerRunOutcome } from '#store/state.js';
import { dispatchTargetKey } from '#scheduler/pendingDispatch.js';

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

async function waitForReconciledRun(watchId: string, entryId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const entry = getSchedulerRunHistory(20, watchId).find((candidate) => candidate.id === entryId);
    if (entry && entry.appStore.runStatus !== 'dispatched') return;
    await wait(10);
  }
  throw new Error(`scheduler did not reconcile run ${entryId}`);
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

test('scheduler restart reconciles every dispatched workflow target with its own result', async () => {
  const created = createWatch({
    bundleId: `com.dkrypt.scheduler.targets.${crypto.randomUUID()}`,
    repo: 'owner/default',
    ghWorkflowFile: 'default.yml',
    dispatchTargets: [
      { repo: 'owner/first', ghWorkflowFile: 'first.yml', mode: 'workflow_dispatch', ref: 'main' },
      { repo: 'owner/second', ghWorkflowFile: 'second.yml', mode: 'workflow_dispatch', ref: 'release' },
    ],
    pollCron: '0 * * * *',
    timezone: 'UTC',
    enabled: false,
  }, 'scheduler recovery test');
  expect(created.watch).toBeDefined();
  const watch = created.watch!;
  const targets = getWatchDispatchTargets(watch);
  const entryId = recordSchedulerRunOutcome({
    watchId: watch.id,
    bundleId: watch.bundleId,
    appStore: {
      ok: true,
      triggered: true,
      reason: 'workflow dispatched',
      runStatus: 'dispatched',
      versionLabel: '1.2.3',
      dispatchTargetKeys: targets.map(dispatchTargetKey),
    },
    testflight: { ok: true, triggered: false, reason: 'no TestFlight run' },
  });
  config.ghToken = 'scheduler-recovery-test-token';
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requestedUrls.push(url);
    if (url.includes('/actions/workflows/first.yml/runs?event=workflow_dispatch')) {
      return Response.json({ workflow_runs: [{ id: 41, status: 'queued', conclusion: null, created_at: new Date(Date.now() + 1).toISOString(), html_url: 'https://github.com/owner/first/actions/runs/41' }] });
    }
    if (url.endsWith('/actions/runs/41')) {
      return Response.json({ id: 41, status: 'completed', conclusion: 'success', created_at: new Date(Date.now() + 1).toISOString(), html_url: 'https://github.com/owner/first/actions/runs/41' });
    }
    if (url.includes('/actions/workflows/second.yml/runs?event=workflow_dispatch')) {
      return Response.json({ workflow_runs: [{ id: 42, status: 'queued', conclusion: null, created_at: new Date(Date.now() + 1).toISOString(), html_url: 'https://github.com/owner/second/actions/runs/42' }] });
    }
    if (url.endsWith('/actions/runs/42')) {
      return Response.json({ id: 42, status: 'completed', conclusion: 'failure', created_at: new Date(Date.now() + 1).toISOString(), html_url: 'https://github.com/owner/second/actions/runs/42' });
    }
    if (url.endsWith('/actions/runs/42/jobs?per_page=100')) {
      return Response.json({ jobs: [{ name: 'Build', conclusion: 'failure', steps: [{ name: 'Build libffi', conclusion: 'failure' }] }] });
    }
    throw new Error(`unexpected GitHub request ${url}`);
  }) as typeof fetch;

  try {
    startScheduler();
    await waitForReconciledRun(watch.id, entryId);

    const outcome = getSchedulerRunHistory(20, watch.id).find((entry) => entry.id === entryId)?.appStore;
    expect(outcome).toMatchObject({
      runStatus: 'failed',
      runUrl: 'https://github.com/owner/second/actions/runs/42',
      failureSummary: 'Build: Build libffi',
    });
    expect(requestedUrls).toContain('https://api.github.com/repos/owner/first/actions/workflows/first.yml/runs?event=workflow_dispatch&per_page=100');
    expect(requestedUrls).toContain('https://api.github.com/repos/owner/second/actions/workflows/second.yml/runs?event=workflow_dispatch&per_page=100');
    expect(requestedUrls.some((url) => url.includes('/repos/owner/default/'))).toBe(false);
  } finally {
    stopScheduler();
    deleteWatch(watch.id, 'scheduler recovery test');
  }
});
