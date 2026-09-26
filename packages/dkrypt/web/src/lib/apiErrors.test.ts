import { expect, test } from 'bun:test';
import { apiErrorMessage } from './apiErrors';

test('apiErrorMessage presents safe remediation for internal errors', () => {
  expect(apiErrorMessage({
    error: 'internal server error',
    remediation: {
      service: 'GitHub',
      upstreamStatus: 403,
      action: 'Verify token permissions and rate limits.',
    },
  }, 502)).toBe('GitHub request failed (HTTP 403). Verify token permissions and rate limits.');
});

test('apiErrorMessage preserves client errors and falls back safely for incomplete envelopes', () => {
  expect(apiErrorMessage({ error: 'you do not have permission' }, 403)).toBe('you do not have permission');
  expect(apiErrorMessage({ error: 'internal server error', remediation: { action: ' ' } }, 500)).toBe('internal server error');
  expect(apiErrorMessage(null, 503)).toBe('Request failed (503)');
});
