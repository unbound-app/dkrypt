import { mock, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from '#jobs/types.js';

const testStateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-shutdown-api-'));
process.env.STATE_DIR = testStateDir;

let releaseDecrypt: (() => void) | undefined;
let markRunnerStarted: (() => void) | undefined;
const decryptGate = new Promise<void>((resolve) => { releaseDecrypt = resolve; });
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('#jobs/runner.js', () => ({
  runDecrypt: async (job: Job) => {
    markRunnerStarted?.();
    await decryptGate;
    job.progress = 'decrypt complete';
  },
}));

const [{ buildServer, registerShutdownHandlers }, { createDevice }, { setCachedDeviceHealth }, { PermissionFlag }, { config }, { setSessionCookie }] = await Promise.all([
  import('#server.js'),
  import('#store/state.js'),
  import('#deviceHealthCache.js'),
  import('#permissions.js'),
  import('#config.js'),
  import('#session.js'),
]);

function createCookie(): string {
  let cookie = '';
  const response = { setHeader: (_name: string, value: string) => { cookie = value; } };
  setSessionCookie(response as never, { sub: 'root', permissions: PermissionFlag.requestDecrypt });
  return cookie.split(';', 1)[0]!;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('SIGTERM drains an active decrypt while public status remains available', async () => {
  const device = createDevice({
    name: `shutdown-api-${crypto.randomUUID()}`,
    transport: 'wifi',
    host: '127.0.0.1',
    iosVersion: '17.0',
    isPrimary: true,
  }, 'tests');
  setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const server = await buildServer();
  const lifecycle = registerShutdownHandlers(server);
  const cookie = createCookie();
  let signalSent = false;

  try {
    const submitted = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie, origin: config.publicBaseUrl, 'sec-fetch-site': 'same-origin' },
      payload: { bundleId: `com.test.shutdown.${crypto.randomUUID()}`, minimumOsVersion: '17.0', preferPrimary: true },
    });

    expect(submitted.statusCode).toBe(202);
    const jobId = (submitted.json() as { id: string }).id;
    await runnerStarted;

    expect(process.emit('SIGTERM')).toBe(true);
    signalSent = true;

    const runningStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
    expect(runningStatus.statusCode).toBe(200);
    expect(runningStatus.json()).toMatchObject({ id: jobId, status: 'running' });

    const rejectedSubmission = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie, origin: config.publicBaseUrl, 'sec-fetch-site': 'same-origin' },
      payload: { bundleId: `com.test.shutdown.rejected.${crypto.randomUUID()}`, minimumOsVersion: '17.0' },
    });
    expect(rejectedSubmission.statusCode).toBe(503);
    expect(rejectedSubmission.json()).toMatchObject({ code: 'service_draining', retryable: true });

    const completionPoll = (async () => {
      let status = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
      for (let attempt = 0; attempt < 100 && status.json().status !== 'done'; attempt += 1) {
        await delay(0);
        status = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
      }
      return status;
    })();
    releaseDecrypt?.();
    const completedStatus = await completionPoll;
    expect(completedStatus.statusCode).toBe(200);
    expect(completedStatus.json()).toMatchObject({ id: jobId, status: 'done' });

    await lifecycle.shutdown('SIGTERM');
  } finally {
    releaseDecrypt?.();
    if (!signalSent) await lifecycle.shutdown('test-cleanup');
    await rm(testStateDir, { recursive: true, force: true });
  }
});
