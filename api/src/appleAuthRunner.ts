import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';
import { log } from './logger.js';
import { clearAppleAuthAlert, setAppleAuthAlert } from './store/state.js';

/**
 * Drives `ipadecrypt bootstrap` headlessly to redo just the Apple ID
 * sign-in step: its prompts fall back to plain stdin reads when stdin isn't
 * a TTY. The device-connection step uses an interactive widget that can't
 * be driven this way, but it's never reached because only the `apple.*`
 * config fields are cleared, leaving `device.*` populated so bootstrap
 * skips straight past it.
 */
interface RunnerState {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  waitingForInput: boolean;
  finished: boolean;
  success?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

let current: RunnerState | undefined;

const IDLE_MS = 600;
const MAX_LINES = 300;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function clearAppleFieldsInConfig(): void {
  const raw = JSON.parse(readFileSync(config.ipadecryptConfigPath, 'utf8')) as Record<string, unknown>;
  raw.apple = {};
  writeFileSync(config.ipadecryptConfigPath, JSON.stringify(raw, null, 2));
}

export function isAppleAuthRunning(): boolean {
  return !!current && !current.finished;
}

export function getAppleAuthStatus() {
  if (!current) return { running: false as const, log: '' };
  return {
    running: !current.finished,
    waitingForInput: current.waitingForInput,
    success: current.success,
    log: current.lines.join('\n'),
  };
}

export function startAppleReauth(): void {
  if (isAppleAuthRunning()) throw new Error('a re-authentication is already running');

  clearAppleFieldsInConfig();

  const child = spawn(config.ipadecryptBin, ['bootstrap'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state: RunnerState = { child, lines: [], waitingForInput: false, finished: false };
  current = state;

  const onChunk = (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString('utf8'));
    if (text.trim()) {
      state.lines.push(...text.split('\n').filter((l) => l.trim() !== ''));
      if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
    }

    state.waitingForInput = false;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.waitingForInput = true;
    }, IDLE_MS);
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('close', (code) => {
    state.finished = true;
    state.waitingForInput = false;
    state.success = code === 0;
    if (state.idleTimer) clearTimeout(state.idleTimer);

    if (code === 0) {
      clearAppleAuthAlert();
      log.info('apple re-authentication succeeded');
    } else {
      const tail = state.lines.slice(-5).join(' / ');
      setAppleAuthAlert(`re-auth process exited with code ${code}: ${tail}`);
      log.error('apple re-authentication failed', { code, tail });
    }
  });

  child.on('error', (err) => {
    state.finished = true;
    state.success = false;
    state.lines.push(`spawn error: ${err.message}`);
  });
}

export function sendAppleAuthInput(value: string): void {
  if (!current || current.finished) throw new Error('no re-authentication is running');
  current.waitingForInput = false;
  current.child.stdin.write(`${value}\n`);
}

export function cancelAppleAuth(): void {
  if (!current || current.finished) return;
  current.child.kill();
}
