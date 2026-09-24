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
  stale: boolean;
  lastEventAt: number | null;
  sequenceGap: boolean;
}>({ overview: null, logs: [], historyAdditions: [], onlineUsers: [], connected: false, overviewLoaded: false, disconnectedAt: null, reconnectAttempts: 0, stale: false, lastEventAt: null, sequenceGap: false });

let source: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let visibilityListenerInstalled = false;
let lastSequence = 0;

function scheduleReconnect(): void {
	if (reconnectTimer || document.visibilityState === 'hidden') return;
	const delay = Math.min(30_000, 1_000 * 2 ** Math.min(liveState.reconnectAttempts - 1, 5));
	reconnectTimer = setTimeout(() => {
		reconnectTimer = undefined;
		connectLive();
	}, delay);
}

function readEvent<T>(event: Event): T {
	const value = JSON.parse((event as MessageEvent).data) as T & { sequence?: number; data?: T };
	if (typeof value.sequence === 'number') {
		if (lastSequence > 0 && value.sequence > lastSequence + 1) liveState.sequenceGap = true;
		lastSequence = Math.max(lastSequence, value.sequence);
		liveState.lastEventAt = Date.now();
		liveState.stale = false;
	}
	if (Array.isArray(value)) return value as T;
	if (value.data !== undefined && Object.keys(value).length === 2) return value.data as T;
	const { sequence: _sequence, ...payload } = value as Record<string, unknown>;
	return payload as T;
}

export function connectLive(): void {
  if (source) return;
  if (!visibilityListenerInstalled) {
		document.addEventListener('visibilitychange', () => {
			if (document.visibilityState === 'visible' && !source) {
				liveState.stale = true;
				scheduleReconnect();
			}
		});
		visibilityListenerInstalled = true;
	}

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
    liveState.stale = false;
    liveState.sequenceGap = false;
  };

  source.addEventListener('overview', (e) => {
    liveState.overview = readEvent<OverviewPayload>(e);
    liveState.overviewLoaded = true;
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  });

  source.addEventListener('log', (e) => {
    const entry = readEvent<LogEntry>(e);
    liveState.logs = [entry, ...liveState.logs].slice(0, 500);
  });

  source.addEventListener('history', (e) => {
    const entry = readEvent<JobHistoryEntry>(e);
    liveState.historyAdditions = [entry, ...liveState.historyAdditions].slice(0, 200);
  });

  source.addEventListener('presence', (e) => {
    liveState.onlineUsers = readEvent<string[]>(e);
  });

  source.onerror = () => {
    source?.close();
    source = null;
    liveState.connected = false;
    if (liveState.disconnectedAt === null) liveState.disconnectedAt = Date.now();
    liveState.stale = true;
    liveState.reconnectAttempts += 1;
    scheduleReconnect();
  };
}

export function disconnectLive(): void {
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  liveState.overview = null;
  liveState.logs = [];
  liveState.historyAdditions = [];
  liveState.onlineUsers = [];
  liveState.connected = false;
  liveState.overviewLoaded = false;
  liveState.disconnectedAt = null;
  liveState.reconnectAttempts = 0;
  liveState.stale = false;
  liveState.lastEventAt = null;
  liveState.sequenceGap = false;
  lastSequence = 0;
}

export function reconnectLive(): void {
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  connectLive();
}
