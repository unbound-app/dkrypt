import { EventEmitter } from 'node:events';
import type { LogEntry } from './logger.js';
import type { JobHistoryEntry } from './store/state.js';

export const dashboardEvents = new EventEmitter();
dashboardEvents.setMaxListeners(0);

export function emitJobsChanged(): void {
  dashboardEvents.emit('jobsChanged');
}

export function emitLogAdded(entry: LogEntry): void {
  dashboardEvents.emit('logAdded', entry);
}

export function emitHistoryAdded(entry: JobHistoryEntry): void {
  dashboardEvents.emit('historyAdded', entry);
}

export function emitAppleAuthChanged(): void {
  dashboardEvents.emit('appleAuthChanged');
}

// Tracks who currently has an open dashboard SSE connection (one browser tab can hold more than
// one, hence a count rather than a boolean) - purely in-memory, resets on server restart, which
// is fine since this only ever answers "who's online right now."
const onlineConnectionCounts = new Map<string, number>();

function onlineUsernames(): string[] {
  return [...onlineConnectionCounts.keys()];
}

export function registerPresence(username: string): void {
  const before = onlineConnectionCounts.size;
  onlineConnectionCounts.set(username, (onlineConnectionCounts.get(username) ?? 0) + 1);
  if (onlineConnectionCounts.size !== before) dashboardEvents.emit('presenceChanged', onlineUsernames());
}

export function unregisterPresence(username: string): void {
  const count = onlineConnectionCounts.get(username);
  if (!count) return;
  if (count <= 1) {
    onlineConnectionCounts.delete(username);
    dashboardEvents.emit('presenceChanged', onlineUsernames());
  } else {
    onlineConnectionCounts.set(username, count - 1);
  }
}

export function getOnlineUsernames(): string[] {
  return onlineUsernames();
}
