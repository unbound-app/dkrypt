import { afterEach, expect, test } from 'bun:test';
import { isSmokeDecryptActive, waitForSmokeDecryptCompletion } from '#jobs/smokeCompletion.js';

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

test('the shutdown smoke does not interrupt a job while it is installing', () => {
  expect(isSmokeDecryptActive('running', 'installing')).toBe(false);
});

test('the shutdown smoke interrupts only while ipadecrypt is running', () => {
  expect(isSmokeDecryptActive('running', 'decrypting')).toBe(true);
});

test('the shutdown smoke does not interrupt a job after ipadecrypt exits', () => {
  expect(isSmokeDecryptActive('running', 'finalizing')).toBe(false);
});

test('the shutdown smoke does not interrupt a queued job with a stale decrypt stage', () => {
  expect(isSmokeDecryptActive('queued', 'decrypting')).toBe(false);
});

function startStatusServer(responses: Array<Record<string, unknown>>): { url: string; requests: string[]; cookies: string[] } {
  const requests: string[] = [];
  const cookies: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      cookies.push(request.headers.get('cookie') ?? '');
      const response = responses.shift();
      return response
        ? Response.json(response)
        : new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, requests, cookies };
}

test('the shutdown smoke waits for a completed decrypt with a checksum-bearing artifact', async () => {
  const statusServer = startStatusServer([
    { status: 'running', deadlineAt: new Date(Date.now() + 10_000).toISOString(), progress: 'verifying IPA' },
    { status: 'done', deadlineAt: new Date(Date.now() + 10_000).toISOString(), progress: 'finished', artifactId: 'artifact-1', sha256: 'a'.repeat(64), sizeBytes: 4096 },
  ]);

  const completed = await waitForSmokeDecryptCompletion({
    baseUrl: statusServer.url,
    jobId: 'job-1',
    sessionCookie: 'session=smoke-session',
    pollIntervalMs: 1,
  });

  expect(completed).toEqual({ artifactId: 'artifact-1', sha256: 'a'.repeat(64), sizeBytes: 4096 });
  expect(statusServer.requests).toEqual([
    'GET /v1/dashboard/jobs/job-1/status',
    'GET /v1/dashboard/jobs/job-1/status',
  ]);
  expect(statusServer.cookies).toEqual(['session=smoke-session', 'session=smoke-session']);
});

test('the shutdown smoke fails with job evidence when the decrypt fails', async () => {
  const statusServer = startStatusServer([
    { status: 'failed', deadlineAt: new Date(Date.now() + 10_000).toISOString(), progress: 'App Store install', error: 'install failed' },
  ]);

  await expect(waitForSmokeDecryptCompletion({
    baseUrl: statusServer.url,
    jobId: 'job-2',
    sessionCookie: 'session=smoke-session',
    pollIntervalMs: 1,
  })).rejects.toThrow('decrypt job failed after restart at App Store install: install failed');
});

test('the shutdown smoke rejects a done job without a verified artifact', async () => {
  const statusServer = startStatusServer([
    { status: 'done', deadlineAt: new Date(Date.now() + 10_000).toISOString(), progress: 'finished', sizeBytes: 4096 },
  ]);

  await expect(waitForSmokeDecryptCompletion({
    baseUrl: statusServer.url,
    jobId: 'job-3',
    sessionCookie: 'session=smoke-session',
    pollIntervalMs: 1,
  })).rejects.toThrow('decrypt job completed without a valid artifact id, SHA-256, and size');
});

test('the shutdown smoke stops polling at the job deadline', async () => {
  const statusServer = startStatusServer([
    { status: 'running', deadlineAt: new Date(Date.now() - 1).toISOString(), progress: 'waiting for device' },
  ]);

  await expect(waitForSmokeDecryptCompletion({
    baseUrl: statusServer.url,
    jobId: 'job-4',
    sessionCookie: 'session=smoke-session',
    pollIntervalMs: 1,
  })).rejects.toThrow('decrypt job deadline elapsed after restart at waiting for device');
  expect(statusServer.requests).toHaveLength(1);
});
