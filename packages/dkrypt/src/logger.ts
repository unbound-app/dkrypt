import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import safeRegex from 'safe-regex2';
import { config } from '#config.js';
import { currentCorrelation } from '#correlation.js';
import { emitLogAdded } from '#events.js';
import { paginateCursor } from '#util/cursor.js';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  id: string;
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
  cursor?: string;
  offset?: number;
  limit?: number;
}

const MAX_LOG_ENTRIES = 500;
const logsPath = path.join(config.stateDir, 'logs.json');

function loadPersistedLogs(): LogEntry[] {
  try {
    if (!existsSync(logsPath)) return [];
    const raw: unknown = JSON.parse(readFileSync(logsPath, 'utf8'));
    return Array.isArray(raw)
      ? (raw as Array<Omit<LogEntry, 'id'> & { id?: string }>).map((entry, index) => ({ ...entry, id: entry.id ?? `legacy-${entry.ts}-${index}` }))
      : [];
  } catch {
    return [];
  }
}

const recentLogs: LogEntry[] = loadPersistedLogs();
let logsDirty = false;

function record(entry: Omit<LogEntry, 'id'>): void {
  const identifiedEntry = { ...entry, id: randomUUID() };
  recentLogs.push(identifiedEntry);
  if (recentLogs.length > MAX_LOG_ENTRIES) recentLogs.shift();
  logsDirty = true;
  emitLogAdded(identifiedEntry);
}

function contextualMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const context = currentCorrelation();
  if (!context) return meta;
  return { ...meta, correlationId: meta?.correlationId ?? context.correlationId, ...(context.traceId ? { traceId: meta?.traceId ?? context.traceId } : {}) };
}

export function getRecentLogs(query: LogQuery = {}): { logs: LogEntry[]; total: number; nextCursor?: string } {
  const search = query.query?.trim();
  if (search && query.regex && !safeRegex(search, { limit: 8 })) throw new Error('unsafe log search pattern');
  const matcher = search && query.regex ? new RegExp(search, 'i') : undefined;
  const normalizedSearch = search?.toLowerCase();
  const matches = (entry: LogEntry): boolean => {
    if (query.scope && entry.scope !== query.scope) return false;
    if (query.level && entry.level !== query.level) return false;
    if (!search) return true;
    const content = `${entry.message} ${entry.meta ? JSON.stringify(entry.meta) : ''}`;
    return matcher ? matcher.test(content) : content.toLowerCase().includes(normalizedSearch as string);
  };
  const filtered = recentLogs.filter(matches);
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, query.limit ?? 100);
  const page = paginateCursor(filtered, {
    cursor: query.cursor,
    offset,
    limit,
    keyOf: (entry) => [entry.ts, entry.id],
    order: 'desc',
  });
  return { logs: page.items, total: filtered.length, nextCursor: page.nextCursor };
}

export function startLogFlusher(): void {
  logFlushTimer ??= setInterval(() => {
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

let logFlushTimer: NodeJS.Timeout | undefined;

export function stopLogFlusher(): void {
  if (logFlushTimer) clearInterval(logFlushTimer);
  logFlushTimer = undefined;
  if (!logsDirty) return;
  try {
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(logsPath, JSON.stringify(recentLogs));
    logsDirty = false;
  } catch {
    return;
  }
}

function ts(): string {
  return new Date().toISOString();
}

function makeLogger(scope: string) {
  return {
    info: (msg: string, meta?: Record<string, unknown>) => {
      const context = contextualMeta(meta);
      console.log(`[${ts()}] INFO  [${scope}] ${msg}`, context ? JSON.stringify(context) : '');
      record({ ts: Date.now(), level: 'info', scope, message: msg, meta: context });
    },
    warn: (msg: string, meta?: Record<string, unknown>) => {
      const context = contextualMeta(meta);
      console.warn(`[${ts()}] WARN  [${scope}] ${msg}`, context ? JSON.stringify(context) : '');
      record({ ts: Date.now(), level: 'warn', scope, message: msg, meta: context });
    },
    error: (msg: string, meta?: Record<string, unknown>) => {
      const context = contextualMeta(meta);
      console.error(`[${ts()}] ERROR [${scope}] ${msg}`, context ? JSON.stringify(context) : '');
      record({ ts: Date.now(), level: 'error', scope, message: msg, meta: context });
    },
  };
}

export function scopedLogger(scope: string) {
  return makeLogger(scope);
}

export const log = makeLogger('general');
