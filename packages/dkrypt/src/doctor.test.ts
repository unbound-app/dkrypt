import { expect, test } from 'bun:test';
import { config } from '#config.js';
import { runConfigurationDoctor } from '#doctor.js';

test('configuration doctor reports runtime security and persistence checks', async () => {
  const result = await runConfigurationDoctor();
  const ids = new Set(result.checks.map((check) => check.id));
  expect(ids.has('database')).toBe(true);
  expect(ids.has('session-secret')).toBe(true);
  expect(ids.has('backup-manifest-secret')).toBe(true);
  expect(ids.has('backup-manifest-rotation')).toBe(true);
  expect(ids.has('public-url')).toBe(true);
  expect(ids.has('runtime-limits')).toBe(true);
  expect(ids.has('device-bridge')).toBe(true);
  expect(ids.has('otel')).toBe(true);
});

test('configuration doctor rejects an outbound rotation with no active signing key', async () => {
  const currentSecret = config.outboundWebhookSecret;
  const previousSecret = config.outboundWebhookSecretPrevious;
  config.outboundWebhookSecret = '';
  config.outboundWebhookSecretPrevious = 'previous_outbound_signing_secret_456';

  try {
    const result = await runConfigurationDoctor();
    expect(result.checks.find((check) => check.id === 'outbound-webhook-rotation')).toMatchObject({
      status: 'error',
      detail: expect.stringContaining('both meet the minimum length'),
    });
  } finally {
    config.outboundWebhookSecret = currentSecret;
    config.outboundWebhookSecretPrevious = previousSecret;
  }
});
