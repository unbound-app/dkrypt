import type { AppleAuthStatus, JobHistoryEntry, LogEntry, OverviewPayload } from './api';

export const liveState = $state<{
  overview: OverviewPayload | null;
  logs: LogEntry[];
  historyAdditions: JobHistoryEntry[];
  appleAuthStatus: AppleAuthStatus | null;
  onlineUsers: string[];
  connected: boolean;
  disconnectedAt: number | null;
  reconnectAttempts: number;
}>({ overview: null, logs: [], historyAdditions: [], appleAuthStatus: null, onlineUsers: [], connected: false, disconnectedAt: null, reconnectAttempts: 0 });

let source: EventSource | null = null;

export function connectLive(): void {
  if (source) return;

  source = new EventSource('/v1/dashboard/events');

  source.onopen = () => {
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  };

  source.addEventListener('overview', (e) => {
    liveState.overview = JSON.parse((e as MessageEvent).data) as OverviewPayload;
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  });

  source.addEventListener('log', (e) => {
    const entry = JSON.parse((e as MessageEvent).data) as LogEntry;
    liveState.logs = [entry, ...liveState.logs].slice(0, 500);
  });

  source.addEventListener('history', (e) => {
    const entry = JSON.parse((e as MessageEvent).data) as JobHistoryEntry;
    liveState.historyAdditions = [entry, ...liveState.historyAdditions].slice(0, 200);
  });

  source.addEventListener('appleAuth', (e) => {
    liveState.appleAuthStatus = JSON.parse((e as MessageEvent).data) as AppleAuthStatus;
  });

  source.addEventListener('presence', (e) => {
    liveState.onlineUsers = JSON.parse((e as MessageEvent).data) as string[];
  });

  // The browser retries automatically on its own backoff - onerror fires once per failed attempt
  // (the initial drop counts as the first), which is what lets the banner show how long it's been
  // down and roughly how hard it's trying, instead of just a static "reconnecting…".
  source.onerror = () => {
    liveState.connected = false;
    if (liveState.disconnectedAt === null) liveState.disconnectedAt = Date.now();
    liveState.reconnectAttempts += 1;
  };
}

export function disconnectLive(): void {
  source?.close();
  source = null;
  liveState.overview = null;
  liveState.logs = [];
  liveState.historyAdditions = [];
  liveState.appleAuthStatus = null;
  liveState.onlineUsers = [];
  liveState.connected = false;
  liveState.disconnectedAt = null;
  liveState.reconnectAttempts = 0;
}

// Force a fresh connection attempt right now instead of waiting on the browser's own EventSource
// retry backoff - keeps already-known state (overview/logs/history) intact while reconnecting.
export function reconnectLive(): void {
  source?.close();
  source = null;
  connectLive();
}
