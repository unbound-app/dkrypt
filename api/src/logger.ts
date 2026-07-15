export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  meta?: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 500;
const recentLogs: LogEntry[] = [];

function record(entry: LogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > MAX_LOG_ENTRIES) recentLogs.shift();
}

/** Most recent first, matching the ordering used elsewhere in the dashboard (job history, etc). */
export function getRecentLogs(): LogEntry[] {
  return [...recentLogs].reverse();
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

/** Tags every entry from this logger with `scope`, so the dashboard's Logs tab can filter by it. */
export function scopedLogger(scope: string) {
  return makeLogger(scope);
}

export const log = makeLogger('general');
