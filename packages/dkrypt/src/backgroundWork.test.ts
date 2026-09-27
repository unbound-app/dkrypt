import { expect, test } from 'bun:test';
import { drainBackgroundWork, trackBackgroundWork } from '#backgroundWork.js';

test('background drain includes work spawned by an operation already in flight', async () => {
  let startParent: (() => void) | undefined;
  let releaseParent: (() => void) | undefined;
  let startChild: (() => void) | undefined;
  let releaseChild: (() => void) | undefined;
  const parentStarted = new Promise<void>((resolve) => { startParent = resolve; });
  const childStarted = new Promise<void>((resolve) => { startChild = resolve; });
  const parentGate = new Promise<void>((resolve) => { releaseParent = resolve; });
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });

  trackBackgroundWork('parent', async () => {
    startParent?.();
    await parentGate;
    void trackBackgroundWork('child', async () => {
      startChild?.();
      await childGate;
    });
  });

  await parentStarted;
  const drain = await drainBackgroundWork(1);
  expect(drain.drained).toBe(false);
  expect(drain.pending).toContain('parent');

  let completionFinished = false;
  void drain.completion.then(() => { completionFinished = true; });
  releaseParent?.();
  await childStarted;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(completionFinished).toBe(false);

  releaseChild?.();
  await drain.completion;
});
