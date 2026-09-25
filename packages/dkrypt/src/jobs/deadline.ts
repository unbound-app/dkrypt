export interface JobDeadlineOptions {
  timeoutMs?: number;
  graceMs: number;
  forceStopWaitMs?: number;
  onDeadline: () => void;
  forceStop: () => void;
  onForceStopTimeout?: (forceStopError?: unknown) => void;
}

type OperationOutcome<T> = { kind: 'completed'; value: T } | { kind: 'failed'; error: unknown };

export async function runWithJobDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller: AbortController,
  options: JobDeadlineOptions,
): Promise<T> {
  const completion: Promise<OperationOutcome<T>> = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value) => ({ kind: 'completed', value }),
      (error: unknown) => ({ kind: 'failed', error }),
  );

  if (options.timeoutMs === undefined) return unwrapOutcome(await completion);
  const timeoutMs = options.timeoutMs;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ kind: 'deadline' }>((resolve) => {
    timeout = setTimeout(() => {
      resolve({ kind: 'deadline' });
      controller.abort(new Error('job deadline exceeded'));
      options.onDeadline();
    }, Math.max(1, timeoutMs));
  });
  const outcome = await Promise.race([completion, deadline]);
  if (outcome.kind !== 'deadline') {
    if (timeout) clearTimeout(timeout);
    return unwrapOutcome(outcome);
  }

  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const graceExpired = new Promise<{ kind: 'grace-expired' }>((resolve) => {
    graceTimer = setTimeout(() => resolve({ kind: 'grace-expired' }), Math.max(0, options.graceMs));
  });
  const afterGrace = await Promise.race([completion, graceExpired]);
  if (graceTimer) clearTimeout(graceTimer);
  if (afterGrace.kind !== 'grace-expired') throw new Error('job deadline exceeded');

  let forceStopError: unknown;
  try {
    options.forceStop();
  } catch (error) {
    forceStopError = error;
  }

  let forceStopTimer: ReturnType<typeof setTimeout> | undefined;
  const forceStopExpired = new Promise<{ kind: 'force-stop-expired' }>((resolve) => {
    forceStopTimer = setTimeout(() => resolve({ kind: 'force-stop-expired' }), Math.max(0, options.forceStopWaitMs ?? options.graceMs));
  });
  const afterForceStop = await Promise.race([completion, forceStopExpired]);
  if (forceStopTimer) clearTimeout(forceStopTimer);
  if (afterForceStop.kind === 'force-stop-expired') {
    try {
      options.onForceStopTimeout?.(forceStopError);
    } finally {
      await completion;
    }
  }
  throw new Error('job deadline exceeded');
}

function unwrapOutcome<T>(outcome: OperationOutcome<T>): T {
  if (outcome.kind === 'failed') throw outcome.error;
  return outcome.value;
}
