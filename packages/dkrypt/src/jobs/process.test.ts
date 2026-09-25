import { expect, test } from 'bun:test';
import { terminateChildProcess } from '#jobs/process.js';

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
