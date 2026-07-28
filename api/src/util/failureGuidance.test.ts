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
