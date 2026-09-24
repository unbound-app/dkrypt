import { expect, test } from 'bun:test';
import { currentCorrelation, withCorrelation } from '#correlation.js';

test('correlation context follows asynchronous work', async () => {
  await withCorrelation({ correlationId: 'request-1', traceId: 'trace-1' }, async () => {
    await Promise.resolve();
    expect(currentCorrelation()).toEqual({ correlationId: 'request-1', traceId: 'trace-1' });
  });
  expect(currentCorrelation()).toBeUndefined();
});
