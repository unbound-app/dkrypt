import { expect, test } from 'bun:test';
import { runKeyedSerial } from './keyedSerial.js';

test('serializes operations by key while allowing unrelated work to proceed', async () => {
  const order: string[] = [];
  let releaseFirst = () => {};
  const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = runKeyedSerial('subscription-1', async () => {
    order.push('first-start');
    await holdFirst;
    order.push('first-finish');
  });
  await Promise.resolve();
  const second = runKeyedSerial('subscription-1', () => { order.push('second'); });
  const unrelated = runKeyedSerial('subscription-2', () => { order.push('unrelated'); });

  await unrelated;
  expect(order).toEqual(['first-start', 'unrelated']);
  releaseFirst();
  await Promise.all([first, second]);

  expect(order).toEqual(['first-start', 'unrelated', 'first-finish', 'second']);
});

test('a rejected operation releases its key for queued and later work', async () => {
  await expect(runKeyedSerial('subscription-1', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
  await expect(runKeyedSerial('subscription-1', () => 'recovered')).resolves.toBe('recovered');
});
