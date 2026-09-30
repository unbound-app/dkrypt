import { expect, test } from 'bun:test';
import { getFailureGuidance } from './failureGuidance.js';

test('offers a concrete recovery action for bridge failures', () => {
  expect(getFailureGuidance('autoinstall bridge request timed out')).toEqual({
    category: 'Timed out',
    title: 'The operation timed out',
    action: 'Check the job timeline and bridge diagnostics before retrying.',
    retryRecommended: true,
  });
});

test('explains queue deadline failures using the blocker recorded on the job', () => {
  expect(getFailureGuidance('job deadline exceeded while waiting in the queue: Waiting for a compatible device')).toEqual({
    category: 'Queue wait expired',
    title: 'The job waited too long to start',
    action: 'Resolve the queue blocker shown in the job timeline or device status, then retry.',
    retryRecommended: true,
  });
});
