import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';
import { emitLogAdded } from '#events.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 500;
const logsPath = path.join(config.stateDir, 'logs.json');

function loadPersistedLogs(): LogEntry[] {
  try {
    if (!existsSync(logsPath)) return [];
    const raw: unknown = JSON.parse(readFileSync(logsPath, 'utf8'));
    return Array.isArray(raw) ? (raw as LogEntry[]) : [];
  } catch {
    return [];
  }
}

const recentLogs: LogEntry[] = loadPersistedLogs();
let logsDirty = false;

function record(entry: LogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_ENTRIES) recentLogs.shift();
  logsDirty = true;
  emitLogAdded(entry);
}

export function getRecentLogs(): LogEntry[] {
  return [...recentLogs].reverse();
}

export function startLogFlusher(): void {
  setInterval(() => {
    if (!logsDirty) return;
    try {
      mkdirSync(config.stateDir, { recursive: true });
      writeFileSync(logsPath, JSON.stringify(recentLogs));
      logsDirty = false;
    } catch {
      // best-effort persistence - logs still work in-memory even if the write fails
    }
  }, 30_000).unref();
}

function ts(): string {
  return new Date().toISOString();
}

function makeLogger(scope: string) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => {
      console.log(`[${ts()}] INFO  [${scope}] ${msg}`, meta ? JSON.stringify(meta) : '');
      record({ ts: Date.now(), level: 'info', scope, message: msg, meta });
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      console.warn(`[${ts()}] WARN  [${scope}] ${msg}`, meta ? JSON.stringify(meta) : '');
      record({ ts: Date.now(), level: 'warn', scope, message: msg, meta });
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      console.error(`[${ts()}] ERROR [${scope}] ${msg}`, meta ? JSON.stringify(meta) : '');
      record({ ts: Date.now(), level: 'error', scope, message: msg, meta });
    },
  };
}

export function scopedLogger(scope: string) {
  return makeLogger(scope);
}

export const log = makeLogger('general');
