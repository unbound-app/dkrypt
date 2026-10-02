import type { DispatchTarget } from '#store/state.js';
import type { JobFailureClass } from '#util/failureCategory.js';

interface DestinationCheck {
  ok: boolean;
  reason: string;
  failureClass?: JobFailureClass;
}

export function destinationFailures<T extends DestinationCheck>(
  targets: DispatchTarget[],
  checks: T[],
): Array<{ target: DispatchTarget; check: T }> {
  return targets.flatMap((target, index) => {
    const check = checks[index];
    return check && !check.ok ? [{ target, check }] : [];
  });
}

export function summarizeDestinationFailures<T extends DestinationCheck>(
  failures: Array<{ target: DispatchTarget; check: T }>,
): string | undefined {
  if (failures.length === 0) return undefined;
  return failures.map(({ target, check }) => {
    const reason = check.reason.length > 240 ? `${check.reason.slice(0, 237)}...` : check.reason;
    return `${target.repo}: ${reason}`;
  }).join('; ');
}
