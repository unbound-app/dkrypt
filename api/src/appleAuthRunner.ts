import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { emitAppleAuthChanged } from './events.js';
import { log } from './logger.js';
import { clearAppleAuthAlert, getPrimaryDevice, setAppleAuthAlert } from './store/state.js';

interface RunnerState {
  child: ChildProcessWithoutNullStreams;
  // Keep the earliest output (often the most diagnostic - connecting/signing-in/2FA prompts)
  // separate from a rolling window of the most recent lines, instead of just dropping the
  // oldest lines once the run gets chatty.
  headLines: string[];
  recentLines: string[];
  totalLineCount: number;
  waitingForInput: boolean;
  finished: boolean;
  success?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
  lastEmitAt: number;
}

const CHUNK_EMIT_THROTTLE_MS = 300;

let current: RunnerState | undefined;

const IDLE_MS = 600;
const HEAD_LINES = 60;
const TAIL_LINES = 240;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\r/g, '');
}

function pushLine(state: RunnerState, line: string): void {
  state.totalLineCount += 1;
  if (state.headLines.length < HEAD_LINES) {
    state.headLines.push(line);
    return;
  }
  state.recentLines.push(line);
  if (state.recentLines.length > TAIL_LINES) state.recentLines.shift();
}

function buildLog(state: RunnerState): string {
  const omitted = state.totalLineCount - state.headLines.length - state.recentLines.length;
  const parts = [...state.headLines];
  if (omitted > 0) parts.push(`… ${omitted} line(s) omitted …`);
  parts.push(...state.recentLines);
  return parts.join('\n');
}

function lastLines(state: RunnerState, n: number): string[] {
  const all = [...state.headLines, ...state.recentLines];
  return all.slice(-n);
}

function clearAppleFieldsInConfig(): void {
  const configPath = path.join(getPrimaryDevice().rootDir, 'config.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  raw.apple = {};
  writeFileSync(configPath, JSON.stringify(raw, null, 2));
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
    log: buildLog(current),
  };
}

export function startAppleReauth(): void {
  if (isAppleAuthRunning()) throw new Error('a re-authentication is already running');

  const child = spawn(config.ipadecryptBin, ['--root-dir', getPrimaryDevice().rootDir, 'bootstrap'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state: RunnerState = { child, headLines: [], recentLines: [], totalLineCount: 0, waitingForInput: false, finished: false, lastEmitAt: 0 };
  current = state;
  emitAppleAuthChanged();

  // Only wipe the previous App Store session once the process has actually spawned - if spawn
  // fails (e.g. missing binary), 'spawn' never fires and the working config is left untouched
  // instead of leaving the user locked out with no restore path.
  child.once('spawn', () => {
    try {
      clearAppleFieldsInConfig();
    } catch (err) {
      pushLine(state, `failed to clear existing Apple config before re-auth: ${String(err)}`);
    }
  });

  const onChunk = (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString('utf8'));
    if (text.trim()) {
      for (const line of text.split('\n')) {
        if (line.trim() !== '') pushLine(state, line);
      }
    }

    state.waitingForInput = false;
    if (state.idleTimer) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      state.waitingForInput = true;
      emitAppleAuthChanged();
    }, IDLE_MS);

    const now = Date.now();
    if (now - state.lastEmitAt >= CHUNK_EMIT_THROTTLE_MS) {
      state.lastEmitAt = now;
      emitAppleAuthChanged();
    }
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
      const tail = lastLines(state, 5).join(' / ');
      setAppleAuthAlert(`re-auth process exited with code ${code}: ${tail}`);
      log.error('apple re-authentication failed', { code, tail });
    }
    emitAppleAuthChanged();
  });

  child.on('error', (err) => {
    state.finished = true;
    state.success = false;
    pushLine(state, `spawn error: ${err.message}`);
    emitAppleAuthChanged();
  });
}

export function sendAppleAuthInput(value: string): void {
  if (!current || current.finished) throw new Error('no re-authentication is running');
  current.waitingForInput = false;
  current.child.stdin.write(`${value}\n`);
  emitAppleAuthChanged();
}

export function cancelAppleAuth(): void {
  if (!current || current.finished) return;
  current.child.kill();
}
