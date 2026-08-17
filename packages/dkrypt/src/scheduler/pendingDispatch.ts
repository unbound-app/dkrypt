import type { DispatchTarget, SchedulerRunEntry } from '#store/state.js';

const PENDING_DISPATCH_WINDOW_MS = 30 * 60_000;

export function dispatchTargetKey(target: DispatchTarget): string {
  const inputs = Object.entries(target.inputs ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([target.repo, target.ghWorkflowFile, target.mode ?? 'repository_dispatch', target.ref ?? '', inputs]);
}

export function filterPendingDispatchTargets(
  targets: DispatchTarget[],
  entries: SchedulerRunEntry[],
  source: 'App Store' | 'TestFlight',
  versionLabel: string,
  now = Date.now(),
  pendingWindowMs = PENDING_DISPATCH_WINDOW_MS,
): DispatchTarget[] {
  const pendingKeys = new Set(
    entries
      .filter((entry) => now - entry.ts >= 0 && now - entry.ts <= pendingWindowMs)
      .map((entry) => source === 'App Store' ? entry.appStore : entry.testflight)
      .filter((outcome) => outcome.runStatus === 'dispatched' && outcome.versionLabel === versionLabel)
      .flatMap((outcome) => outcome.dispatchTargetKeys ?? []),
  );

  return targets.filter((target) => !pendingKeys.has(dispatchTargetKey(target)));
}
