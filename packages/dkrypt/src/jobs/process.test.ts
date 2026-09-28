import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { terminateChildProcess } from '#jobs/process.js';
import { runWithJobDeadline } from '#jobs/deadline.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isProcessAlive(pid: number): boolean {
  const result = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (result.error) throw result.error;
  const state = result.stdout.trim();
  return result.status === 0 && state.length > 0 && !state.startsWith('Z');
}

async function waitForCondition(check: () => boolean | Promise<boolean>, failureMessage: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(10);
  }
  throw new Error(failureMessage);
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number, failureMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(failureMessage)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

test('force kill still reaches a process after a graceful signal has been sent', () => {
  const signals: string[] = [];
  const child = {
    exitCode: null,
    signalCode: null,
    killed: true,
    kill: (signal: string) => {
      signals.push(signal);
      return true;
    },
  } as unknown as import('node:child_process').ChildProcess;

  terminateChildProcess(child, 'SIGKILL');

  expect(signals).toEqual(['SIGKILL']);
});

test('deadline force-kills descendants that ignore graceful termination in the decrypt process group', async () => {
  if (process.platform === 'win32') return;

  const directory = await mkdtemp(path.join(tmpdir(), 'dkrypt-process-group-'));
  const heartbeatPath = path.join(directory, 'descendant-heartbeat');
  const signalPath = path.join(directory, 'descendant-signal');
  const descendantScript = `const fs = require('node:fs'); const writeHeartbeat = () => fs.writeFileSync(${JSON.stringify(heartbeatPath)}, String(Date.now())); process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(signalPath)}, 'received')); writeHeartbeat(); setInterval(writeHeartbeat, 10); process.stdout.write('ready')`;
  const parentScript = [
    "const { spawn } = require('node:child_process')",
    "process.on('SIGTERM', () => {})",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: ['ignore', 'pipe', 'ignore'] })`,
    "descendant.stdout.once('data', () => process.stdout.write(String(descendant.pid)))",
    'setInterval(() => {}, 1000)',
  ].join(';');
  const child = spawn(process.execPath, ['-e', parentScript], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let output = '';
  let descendantPid: number | undefined;

  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
    const parsedDescendantPid = Number(output.trim());
    if (Number.isSafeInteger(parsedDescendantPid) && parsedDescendantPid > 0) descendantPid = parsedDescendantPid;
  });

  try {
    await waitForCondition(() => descendantPid !== undefined, 'decrypt fixture descendant did not start');
    if (descendantPid === undefined) throw new Error('decrypt fixture descendant did not start');
    const runningDescendantPid = descendantPid;

    const graceMs = 50;
    const controller = new AbortController();
    const firstHeartbeat = Number(await readFile(heartbeatPath, 'utf8'));
    let deadlineAt: number | undefined;
    let forceKillAt: number | undefined;
    let heartbeatAtForceKill = firstHeartbeat;
    const deadline = runWithJobDeadline(
      (signal) => new Promise<void>((resolve) => {
        const requestGracefulStop = () => terminateChildProcess(child, 'SIGTERM');
        signal.addEventListener('abort', requestGracefulStop, { once: true });
        child.once('close', () => {
          signal.removeEventListener('abort', requestGracefulStop);
          resolve();
        });
      }),
      controller,
      {
        timeoutMs: graceMs,
        graceMs,
        forceStopWaitMs: 5_000,
        onDeadline: () => { deadlineAt = Date.now(); },
        forceStop: () => {
          forceKillAt = Date.now();
          try {
            heartbeatAtForceKill = Number(readFileSync(heartbeatPath, 'utf8'));
          } catch {
            heartbeatAtForceKill = Number.NaN;
          }
          terminateChildProcess(child, 'SIGKILL');
        },
      },
    );

    const deadlineOutcome = deadline.then(
      () => { throw new Error('deadline supervisor completed without reporting the deadline'); },
      (error: unknown) => {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('job deadline exceeded');
      },
    );
    await settleWithin(deadlineOutcome, 2_000, 'deadline run did not settle after force-kill');

    await waitForCondition(async () => await readFile(signalPath, 'utf8').catch(() => '') === 'received', 'decrypt fixture descendant did not receive SIGTERM');
    expect(heartbeatAtForceKill).toBeGreaterThan(firstHeartbeat);
    expect(forceKillAt! - deadlineAt!).toBeGreaterThanOrEqual(graceMs - 5);
    expect(forceKillAt! - deadlineAt!).toBeLessThan(1_000);
    await waitForCondition(() => !isProcessAlive(runningDescendantPid), 'descendant process remained after deadline force-kill');
    expect(Number(await readFile(heartbeatPath, 'utf8'))).toBeGreaterThan(firstHeartbeat);
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
