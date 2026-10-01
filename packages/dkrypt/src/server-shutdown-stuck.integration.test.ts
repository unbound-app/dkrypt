import { mock, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Job } from '#jobs/types.js';

const testStateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-shutdown-stuck-'));
process.env.STATE_DIR = testStateDir;

let markRunnerStarted: (() => void) | undefined;
const runnerStarted = new Promise<void>((resolve) => { markRunnerStarted = resolve; });
const childSignals: string[] = [];
const childProcess = {
  pid: undefined,
  exitCode: null,
  signalCode: null,
  kill: (signal: string) => {
    childSignals.push(signal);
    return true;
  },
} as unknown as ChildProcess;

mock.module('#jobs/runner.js', () => ({
  runDecrypt: (job: Job) => {
    markRunnerStarted?.();
    job.childProcess = childProcess;
    return new Promise<void>(() => {});
  },
}));

const [{ buildServer, registerShutdownHandlers }, { createDevice }, { setCachedDeviceHealth }, { PermissionFlag }, { config }, { setSessionCookie }, { openStateCollectionDatabase, readStateCollection }, { recoverPersistedActiveJobs }] = await Promise.all([
  import('#server.js'),
  import('#store/state.js'),
  import('#deviceHealthCache.js'),
  import('#permissions.js'),
  import('#config.js'),
  import('#session.js'),
  import('#store/sqlite.js'),
  import('#jobs/store.js'),
]);

function createCookie(): string {
  let cookie = '';
  const response = { setHeader: (_name: string, value: string) => { cookie = value; } };
  setSessionCookie(response as never, { sub: 'root', permissions: PermissionFlag.requestDecrypt });
  return cookie.split(';', 1)[0]!;
}

test('a runner stuck past the force-stop grace is durably recoverable before process exit', async () => {
  const device = createDevice({
    name: `shutdown-stuck-${crypto.randomUUID()}`,
    transport: 'wifi',
    host: '127.0.0.1',
    iosVersion: '17.0',
    isPrimary: true,
  }, 'tests');
  setCachedDeviceHealth(device.id, { reachable: true, jailbreakAvailable: true, checkedAt: Date.now() });
  const server = await buildServer();
  server.close = (() => new Promise<void>(() => {})) as typeof server.close;
  let processExitCode: number | undefined;
  let persistedJobsAtExit: Job[] = [];
  let recoveredJobsAtExit: Job[] = [];
  const lifecycle = registerShutdownHandlers(server, {
    jobDrainTimeoutMs: 25,
    serverCloseTimeoutMs: 25,
    processExit: (code) => {
      processExitCode = code;
      const database = openStateCollectionDatabase({
        stateDir: testStateDir,
        filename: config.stateDatabaseFile,
        busyTimeoutMs: config.stateDbBusyTimeoutMs,
      }, ['jobs', 'job_timelines']);
      try {
        persistedJobsAtExit = readStateCollection(database, 'jobs') as Job[];
        recoveredJobsAtExit = recoverPersistedActiveJobs(persistedJobsAtExit).queued;
      } finally {
        database.close();
      }
    },
  });
  const cookie = createCookie();
  let signalSent = false;

  try {
    const submitted = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/decrypt',
      headers: { cookie, origin: config.publicBaseUrl, 'sec-fetch-site': 'same-origin' },
      payload: { bundleId: `com.test.shutdown.stuck.${crypto.randomUUID()}`, minimumOsVersion: '17.0', preferPrimary: true },
    });
    expect(submitted.statusCode).toBe(202);
    const jobId = (submitted.json() as { id: string }).id;
    await runnerStarted;

    expect(process.emit('SIGTERM')).toBe(true);
    signalSent = true;
    const runningStatus = await server.inject({ method: 'GET', url: `/v1/dashboard/jobs/${jobId}/status`, headers: { cookie } });
    expect(runningStatus.json()).toMatchObject({ id: jobId, status: 'running' });
    await lifecycle.shutdown('SIGTERM');

    expect(childSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(processExitCode).toBe(0);
    expect(persistedJobsAtExit).toContainEqual(expect.objectContaining({
      id: jobId,
      status: 'running',
      shutdownRecoveryPending: true,
    }));
    expect(recoveredJobsAtExit).toContainEqual(expect.objectContaining({
      id: jobId,
      status: 'queued',
      progress: 'queued after graceful shutdown',
    }));
  } finally {
    if (!signalSent) await lifecycle.shutdown('test-cleanup');
    await rm(testStateDir, { recursive: true, force: true });
  }
});
