import { expect, test } from 'bun:test';
import { categorizeFailure } from './failureCategory';

test('distinguishes queue deadline failures from operation timeouts', () => {
  expect(categorizeFailure('job deadline exceeded while waiting in the queue: Waiting for a compatible device')).toBe('Queue wait expired');
  expect(categorizeFailure('TestFlight bridge timed out')).toBe('Timed out');
});
