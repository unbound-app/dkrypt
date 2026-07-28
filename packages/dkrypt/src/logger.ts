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

export interface LogQuery {
  scope?: string;
  level?: LogLevel;
  query?: string;
  regex?: boolean;
  offset?: number;
  limit?: number;
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

export function getRecentLogs(query: LogQuery = {}): { logs: LogEntry[]; total: number } {
  const search = query.query?.trim();
  const matcher = search && query.regex ? new RegExp(search, 'i') : undefined;
  const normalizedSearch = search?.toLowerCase();
  const matches = (entry: LogEntry): boolean => {
    if (query.scope && entry.scope !== query.scope) return false;
    if (query.level && entry.level !== query.level) return false;
    if (!search) return true;
    const content = `${entry.message} ${entry.meta ? JSON.stringify(entry.meta) : ''}`;
    return matcher ? matcher.test(content) : content.toLowerCase().includes(normalizedSearch as string);
  };
  const filtered = recentLogs.filter(matches).reverse();
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, query.limit ?? 100);
  return { logs: filtered.slice(offset, offset + limit), total: filtered.length };
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
