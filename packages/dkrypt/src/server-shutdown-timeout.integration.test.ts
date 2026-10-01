import { mock, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from '#jobs/types.js';

const testStateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-shutdown-recovery-'));
process.env.STATE_DIR = testStateDir;

let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });

mock.module('#jobs/runner.js', () => ({
  runDecrypt: (_job: Job, _device: unknown, signal?: AbortSignal) => {
    markRunnerStarted?.();
    return new Promise<void>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
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

test('a decrypt that misses the shutdown drain deadline is queued for recovery', async () => {
  const device = createDevice({
    name: `shutdown-recovery-${crypto.randomUUID()}`,
    transport: 'wifi',
    host: '127.0.0.1',
    iosVersion: '17.0',
    isPrimary: true,
  }, 'tests');
  setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const server = await buildServer();
  const lifecycle = registerShutdownHandlers(server, { jobDrainTimeoutMs: 25 });
  const cookie = createCookie();
  let signalSent = false;

  try {
    const submitted = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie, origin: config.publicBaseUrl, 'sec-fetch-site': 'same-origin' },
      payload: { bundleId: `com.test.shutdown.recovery.${crypto.randomUUID()}`, minimumOsVersion: '17.0', preferPrimary: true },
    });

    expect(submitted.statusCode).toBe(202);
    const jobId = (submitted.json() as { id: string }).id;
    await runnerStarted;
    expect(process.emit('SIGTERM')).toBe(true);
    signalSent = true;

    const runningStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
    expect(runningStatus.json()).toMatchObject({ id: jobId, status: 'running' });

    let recoveredStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
    for (let attempt = 0; attempt < 100 && recoveredStatus.json().status !== 'queued'; attempt += 1) {
      await delay(2);
      recoveredStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
    }
    expect(recoveredStatus.statusCode).toBe(200);
    expect(recoveredStatus.json()).toMatchObject({ id: jobId, status: 'queued', progress: 'queued after graceful shutdown' });

    await lifecycle.shutdown('SIGTERM');
  } finally {
    if (!signalSent) await lifecycle.shutdown('test-cleanup');
    await rm(testStateDir, { recursive: true, force: true });
  }
});
