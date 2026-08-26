import { describe, expect, test } from 'bun:test';

async function loadDefaultRetention(): Promise<{ jobRetentionMinutes: number }> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ jobRetentionMinutes: config.jobRetentionMinutes }));",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`config defaults lookup failed: ${stderr}`);
  return JSON.parse(stdout) as { jobRetentionMinutes: number };
}

async function loadStripeMissingConfiguration(): Promise<string[]> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { stripeMissingConfiguration } = await import('./src/config.ts'); console.log(JSON.stringify(stripeMissingConfiguration));",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        STRIPE_SECRET_KEY: '',
        STRIPE_WEBHOOK_SECRET: '',
        STRIPE_REGULAR_PRICE_ID: '',
        STRIPE_PRIORITY_PRICE_ID: '',
        STRIPE_API_PRICE_ID: '',
        STRIPE_PRIORITY_API_PRICE_ID: '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Stripe configuration lookup failed: ${stderr}`);
  return JSON.parse(stdout) as string[];
}

async function loadStripeEnvironment(secretKey: string): Promise<string> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { stripeEnvironment } = await import('./src/config.ts'); console.log(stripeEnvironment);",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        SESSION_SIGNING_SECRET: 'config-test-session-signing-secret',
        ADMIN_PASSWORD: 'config-test-admin-password',
        STRIPE_SECRET_KEY: secretKey,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Stripe environment lookup failed: ${stderr}`);
  return stdout.trim();
}

describe('config defaults', () => {
  test('keeps completed job history for 24 hours by default', async () => {
    await expect(loadDefaultRetention()).resolves.toEqual({ jobRetentionMinutes: 1440 });
  });

  test('reports every missing Stripe runtime prerequisite', async () => {
    await expect(loadStripeMissingConfiguration()).resolves.toEqual([
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_REGULAR_PRICE_ID',
      'STRIPE_PRIORITY_PRICE_ID',
      'STRIPE_API_PRICE_ID',
      'STRIPE_PRIORITY_API_PRICE_ID',
    ]);
  });

  test('recognizes restricted live Stripe keys as live mode', async () => {
    await expect(loadStripeEnvironment('rk_live_config-test-key')).resolves.toBe('live');
  });
});
