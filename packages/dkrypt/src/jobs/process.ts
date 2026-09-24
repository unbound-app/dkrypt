import type { ChildProcess } from 'node:child_process';

export function terminateChildProcess(child: ChildProcess | undefined, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined) || child.killed) return;
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  child.kill(signal);
}
