import { expect, test } from 'bun:test';
import { categorizeFailure, classifyJobFailure } from './failureCategory.js';

test('classifies queue deadline failures separately from work timeouts', () => {
  const message = 'job deadline exceeded while waiting in the queue: Waiting for a compatible device';

  expect(classifyJobFailure(message)).toBe('queue');
  expect(categorizeFailure(message)).toBe('Queue wait expired');
});
