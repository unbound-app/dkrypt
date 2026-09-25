import { expect, test } from 'bun:test';
import { runWithJobDeadline } from '#jobs/deadline.js';

test('a deadline aborts job work and waits for its cleanup before rejecting', async () => {
  const controller = new AbortController();
  let cleanupFinished = false;
  let forceStopped = false;

  await expect(runWithJobDeadline(
    (signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        setTimeout(() => {
          cleanupFinished = true;
          reject(signal.reason);
        }, 5);
      }, { once: true });
    }),
    controller,
    { timeoutMs: 5, graceMs: 50, onDeadline: () => {}, forceStop: () => { forceStopped = true; } },
  )).rejects.toThrow('job deadline exceeded');

  expect(cleanupFinished).toBe(true);
  expect(forceStopped).toBe(false);
});

test('a deadline force-stops work after the grace period and awaits its termination', async () => {
  const controller = new AbortController();
  let finishOperation: (() => void) | undefined;
  let forceStopped = false;
  let workFinished = false;

  await expect(runWithJobDeadline(
    () => new Promise<void>((resolve) => {
      finishOperation = () => {
        workFinished = true;
        resolve();
      };
    }),
    controller,
    { timeoutMs: 5, graceMs: 5, forceStopWaitMs: 5, onDeadline: () => {}, forceStop: () => { forceStopped = true; finishOperation?.(); } },
  )).rejects.toThrow('job deadline exceeded');

  expect(forceStopped).toBe(true);
  expect(workFinished).toBe(true);
});

test('keeps supervising device work after force-kill until it actually exits', async () => {
  const controller = new AbortController();
  let forceStopped = false;
  let operationSettled = false;
  let finishOperation: (() => void) | undefined;
  let markWaiting: (() => void) | undefined;
  const waitingForStop = new Promise<void>((resolve) => { markWaiting = resolve; });

  const operation = runWithJobDeadline(
    () => new Promise<void>((resolve) => {
      finishOperation = () => {
        operationSettled = true;
        resolve();
      };
    }),
    controller,
    {
      timeoutMs: 5,
      graceMs: 5,
      forceStopWaitMs: 5,
      onDeadline: () => {},
      forceStop: () => { forceStopped = true; },
      onForceStopTimeout: () => markWaiting?.(),
    },
  );
  const outcome = operation.then(
    () => { throw new Error('expected deadline rejection'); },
    (error: unknown) => error instanceof Error ? error : new Error(String(error)),
  );
  await waitingForStop;

  expect(forceStopped).toBe(true);
  expect(operationSettled).toBe(false);
  finishOperation?.();
  await expect(outcome).resolves.toMatchObject({ message: 'job deadline exceeded' });
  expect(operationSettled).toBe(true);
});
