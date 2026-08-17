import { describe, expect, test } from 'bun:test';
import type { DispatchTarget, SchedulerRunEntry } from '#store/state.js';
import { dispatchTargetKey, filterPendingDispatchTargets } from '#scheduler/pendingDispatch.js';

const firstTarget: DispatchTarget = {
  repo: 'unbound-app/loader-ios',
  ghWorkflowFile: 'remote-deploy.yml',
};

const secondTarget: DispatchTarget = {
  repo: 'unbound-app/loader-ios-fallback',
  ghWorkflowFile: 'remote-deploy.yml',
  mode: 'workflow_dispatch',
  ref: 'main',
};

function entry(overrides: Partial<SchedulerRunEntry['appStore']> = {}, ts = 1_000): SchedulerRunEntry {
  return {
    id: 'run-1',
    ts,
    appStore: {
      ok: true,
      triggered: true,
      reason: 'dispatched',
      versionLabel: 'v341.0',
      dispatchTargetKeys: [dispatchTargetKey(firstTarget)],
      runStatus: 'dispatched',
      ...overrides,
    },
    testflight: { ok: true, triggered: false, reason: 'not checked' },
  };
}

describe('pending scheduler dispatches', () => {
  test('suppresses only targets with a recent dispatched run for the same version', () => {
    const pending = filterPendingDispatchTargets(
      [firstTarget, secondTarget],
      [entry()],
      'App Store',
      'v341.0',
      1_000,
    );

    expect(pending).toEqual([secondTarget]);
  });

  test('does not suppress completed, failed, or expired dispatches', () => {
    const entries = [
      entry({ runStatus: 'succeeded' }),
      entry({ runStatus: 'failed' }),
      entry({}, 0),
    ];

    expect(filterPendingDispatchTargets([firstTarget], entries, 'App Store', 'v341.0', 31 * 60_000)).toEqual([firstTarget]);
  });
});
