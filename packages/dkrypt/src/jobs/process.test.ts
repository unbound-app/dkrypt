import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { terminateChildProcess } from '#jobs/process.js';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

test('force-kills descendants that ignore graceful termination in the decrypt process group', async () => {
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
    for (let attempt = 0; attempt < 500 && descendantPid === undefined; attempt += 1) await delay(10);
    expect(descendantPid).toBeDefined();

    terminateChildProcess(child, 'SIGTERM');
    let signalReceived = '';
    for (let attempt = 0; attempt < 500 && signalReceived !== 'received'; attempt += 1) {
      signalReceived = await readFile(signalPath, 'utf8').catch(() => '');
      if (signalReceived !== 'received') await delay(10);
    }
    expect(signalReceived).toBe('received');

    const firstHeartbeat = Number(await readFile(heartbeatPath, 'utf8'));
    let heartbeatAfterGrace = firstHeartbeat;
    for (let attempt = 0; attempt < 500 && heartbeatAfterGrace <= firstHeartbeat; attempt += 1) {
      await delay(10);
      heartbeatAfterGrace = Number(await readFile(heartbeatPath, 'utf8'));
    }
    expect(heartbeatAfterGrace).toBeGreaterThan(firstHeartbeat);

    terminateChildProcess(child, 'SIGKILL');

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('decrypt process group did not terminate after force-kill')), 5_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    let finalHeartbeat = await readFile(heartbeatPath, 'utf8');
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await delay(20);
      const currentHeartbeat = await readFile(heartbeatPath, 'utf8');
      expect(currentHeartbeat).toBe(finalHeartbeat);
      finalHeartbeat = currentHeartbeat;
    }
  } finally {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }
    await rm(directory, { recursive: true, force: true });
  }
});
