import { getEffectiveWatches, getWatchDispatchTargets, type AppWatch, type CreateWatchInput } from '#store/state.js';
import { nextRunnableCronOccurrence } from '#util/maintenanceWindow.js';
import { effectiveTimeZone } from '#util/timezone.js';

export interface WatchConflict {
  watchId: string;
  bundleId: string;
  target: string;
  nextOverlapAt: number;
}

function occurrences(watch: Pick<AppWatch, 'pollCron' | 'timezone' | 'maintenanceWindow'>, fromAt: number, untilAt: number): number[] {
  const times: number[] = [];
  let cursor = fromAt;
  for (let index = 0; index < 1000; index += 1) {
    const next = nextRunnableCronOccurrence(watch.pollCron, effectiveTimeZone(watch.timezone), watch.maintenanceWindow, cursor, untilAt);
    if (!next) break;
    times.push(next.at);
    cursor = next.at;
  }
  return times;
}

export function findWatchConflicts(input: CreateWatchInput, excludeWatchId?: string, now = Date.now()): WatchConflict[] {
  if (input.enabled === false) return [];
  const targets = new Set(getWatchDispatchTargets(input).map((target) => `${target.repo}/${target.ghWorkflowFile}:${target.ref ?? ''}`));
  if (targets.size === 0) return [];
  const untilAt = now + 7 * 24 * 60 * 60 * 1000;
  const candidateTimes = new Set(occurrences(input, now, untilAt));
  const conflicts: WatchConflict[] = [];
  for (const watch of getEffectiveWatches()) {
    if (!watch.enabled || watch.id === excludeWatchId || (watch.projectId ?? 'default') !== (input.projectId ?? 'default')) continue;
    const target = getWatchDispatchTargets(watch).map((entry) => `${entry.repo}/${entry.ghWorkflowFile}:${entry.ref ?? ''}`).find((key) => targets.has(key));
    if (!target) continue;
    const nextOverlapAt = occurrences(watch, now, untilAt).find((at) => candidateTimes.has(at));
    if (nextOverlapAt === undefined) continue;
    conflicts.push({ watchId: watch.id, bundleId: watch.bundleId, target, nextOverlapAt });
  }
  return conflicts.sort((left, right) => left.nextOverlapAt - right.nextOverlapAt);
}
