import type { JobHistoryEntry, LogEntry, OverviewPayload } from '#lib/api';

export const liveState = $state<{
  overview: OverviewPayload | null;
  logs: LogEntry[];
  historyAdditions: JobHistoryEntry[];
  onlineUsers: string[];
  connected: boolean;
  overviewLoaded: boolean;
  disconnectedAt: number | null;
  reconnectAttempts: number;
}>({ overview: null, logs: [], historyAdditions: [], onlineUsers: [], connected: false, overviewLoaded: false, disconnectedAt: null, reconnectAttempts: 0 });

let source: EventSource | null = null;

export function connectLive(): void {
  if (source) return;

  source = new EventSource('/v1/dashboard/events');
  const initialSource = source;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  void fetch('/v1/dashboard/overview', { signal: controller.signal })
    .then(async (response) => {
      if (!response.ok) return;
      liveState.overview = (await response.json()) as OverviewPayload;
    })
    .catch(() => {})
    .finally(() => {
      clearTimeout(timeout);
      if (source === initialSource) liveState.overviewLoaded = true;
    });

  source.onopen = () => {
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  };

  source.addEventListener('overview', (e) => {
    liveState.overview = JSON.parse((e as MessageEvent).data) as OverviewPayload;
    liveState.overviewLoaded = true;
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

  source.addEventListener('presence', (e) => {
    liveState.onlineUsers = JSON.parse((e as MessageEvent).data) as string[];
  });

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
  liveState.onlineUsers = [];
  liveState.connected = false;
  liveState.overviewLoaded = false;
  liveState.disconnectedAt = null;
  liveState.reconnectAttempts = 0;
}

export function reconnectLive(): void {
  source?.close();
  source = null;
  connectLive();
}
