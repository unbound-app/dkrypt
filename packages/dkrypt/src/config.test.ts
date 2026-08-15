import { describe, expect, test } from 'bun:test';

async function loadDefaultTtls(): Promise<{ fileTtlMinutes: number; jobRetentionMinutes: number }> {
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      "const { config } = await import('./src/config.ts'); console.log(JSON.stringify({ fileTtlMinutes: config.fileTtlMinutes, jobRetentionMinutes: config.jobRetentionMinutes }));",
    ],
    {
      cwd: process.cwd(),
      env: {
        API_KEY: 'config-test-api-key',
        DOWNLOAD_SIGNING_SECRET: 'config-test-signing-secret',
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
  return JSON.parse(stdout) as { fileTtlMinutes: number; jobRetentionMinutes: number };
}

describe('config defaults', () => {
  test('keeps completed jobs and their files for 24 hours by default', async () => {
    await expect(loadDefaultTtls()).resolves.toEqual({ fileTtlMinutes: 1440, jobRetentionMinutes: 1440 });
  });
});
