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

test('configuration doctor validates SMTP and OAuth secret rotations', async () => {
  const previous = {
    smtpPass: config.smtpPass,
    smtpPassPrevious: config.smtpPassPrevious,
    nowpaymentsApiKey: config.nowpaymentsApiKey,
    nowpaymentsApiKeyPrevious: config.nowpaymentsApiKeyPrevious,
    githubSecret: config.githubOauthClientSecret,
    githubSecretPrevious: config.githubOauthClientSecretPrevious,
    discordSecret: config.discordOauthClientSecret,
    discordSecretPrevious: config.discordOauthClientSecretPrevious,
  };
  config.smtpPass = '';
  config.smtpPassPrevious = 'previous-smtp-password';
  config.nowpaymentsApiKey = 'current_nowpayments_api_key_123456';
  config.nowpaymentsApiKeyPrevious = 'short';
  config.githubOauthClientSecret = 'current-github-client-secret-123';
  config.githubOauthClientSecretPrevious = 'short';
  config.discordOauthClientSecret = 'current-discord-client-secret-123';
  config.discordOauthClientSecretPrevious = config.discordOauthClientSecret;

  try {
    const result = await runConfigurationDoctor();
    const checks = new Map(result.checks.map((check) => [check.id, check]));

    expect(checks.get('smtp-secret-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('crypto-api-key-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('github-oauth-secret-rotation')).toMatchObject({ status: 'error' });
    expect(checks.get('discord-oauth-secret-rotation')).toMatchObject({ status: 'error' });

    config.smtpPass = 'current-smtp-password';
    config.smtpPassPrevious = 'previous-smtp-password';
    config.nowpaymentsApiKeyPrevious = 'previous_nowpayments_api_key_123456';
    config.githubOauthClientSecretPrevious = 'previous-github-client-secret-456';
    config.discordOauthClientSecretPrevious = 'previous-discord-client-secret-456';
    const validResult = await runConfigurationDoctor();
    const validChecks = new Map(validResult.checks.map((check) => [check.id, check]));

    expect(validChecks.get('smtp-secret-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('crypto-api-key-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('github-oauth-secret-rotation')).toMatchObject({ status: 'ok' });
    expect(validChecks.get('discord-oauth-secret-rotation')).toMatchObject({ status: 'ok' });
  } finally {
    config.smtpPass = previous.smtpPass;
    config.smtpPassPrevious = previous.smtpPassPrevious;
    config.nowpaymentsApiKey = previous.nowpaymentsApiKey;
    config.nowpaymentsApiKeyPrevious = previous.nowpaymentsApiKeyPrevious;
    config.githubOauthClientSecret = previous.githubSecret;
    config.githubOauthClientSecretPrevious = previous.githubSecretPrevious;
    config.discordOauthClientSecret = previous.discordSecret;
    config.discordOauthClientSecretPrevious = previous.discordSecretPrevious;
  }
});
