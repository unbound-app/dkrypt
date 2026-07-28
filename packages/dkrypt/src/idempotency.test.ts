import { expect, test } from 'bun:test';
import { IdempotencyRegistry } from '#idempotency.js';

test('IdempotencyRegistry returns the original job for an equivalent retry and rejects changed input', () => {
  const registry = new IdempotencyRegistry();
  registry.record('key-1', 'retry-1', 'request-a', 'job-1', 1_000, 10);

  expect(registry.lookup('key-1', 'retry-1', 'request-a', 11)).toEqual({ jobId: 'job-1', conflict: false });
  expect(registry.lookup('key-1', 'retry-1', 'request-b', 11)).toEqual({ conflict: true });
  expect(registry.lookup('key-1', 'retry-1', 'request-a', 1_010)).toEqual({ conflict: false });
});
