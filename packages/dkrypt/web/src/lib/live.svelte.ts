import type { JobHistoryEntry, LogEntry, OverviewPayload } from '#lib/api';
import { projectSelectionState, setProjectSelection } from '#lib/projectSelection.svelte';
import { serverStateCache } from '#lib/serverStateCache.svelte';

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
let overviewRefresh: Promise<void> | undefined;
let hasConnectedBefore = false;

async function refreshOverview(): Promise<void> {
	if (overviewRefresh) return overviewRefresh;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	overviewRefresh = fetch(`/v1/dashboard/overview?projectId=${encodeURIComponent(projectSelectionState.id)}`, { signal: controller.signal })
		.then(async (response) => {
			if (!response.ok) return;
			liveState.overview = (await response.json()) as OverviewPayload;
			liveState.overviewLoaded = true;
			liveState.sequenceGap = false;
			liveState.stale = false;
		})
		.catch(() => {})
		.finally(() => {
			clearTimeout(timeout);
			overviewRefresh = undefined;
		});
	return overviewRefresh;
}

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
		if (lastSequence > 0 && value.sequence > lastSequence + 1) {
			liveState.sequenceGap = true;
			serverStateCache.invalidateAll();
			void refreshOverview();
		}
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

  const eventSource = new EventSource(`/v1/dashboard/events?projectId=${encodeURIComponent(projectSelectionState.id)}`);
  source = eventSource;
  const initialSource = eventSource;
	void refreshOverview().finally(() => {
		if (source === initialSource) liveState.overviewLoaded = true;
	});

  eventSource.onopen = () => {
    if (hasConnectedBefore && liveState.disconnectedAt !== null) serverStateCache.invalidateAll();
    hasConnectedBefore = true;
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
    liveState.stale = false;
    liveState.sequenceGap = false;
  };

  eventSource.addEventListener('overview', (e) => {
    liveState.overview = readEvent<OverviewPayload>(e);
    serverStateCache.invalidatePrefix('/v1/dashboard/devices');
    liveState.overviewLoaded = true;
    liveState.connected = true;
    liveState.disconnectedAt = null;
    liveState.reconnectAttempts = 0;
  });

  eventSource.addEventListener('log', (e) => {
    const entry = readEvent<LogEntry>(e);
    serverStateCache.invalidatePrefix('/v1/dashboard/logs');
    liveState.logs = [entry, ...liveState.logs].slice(0, 500);
  });

  eventSource.addEventListener('history', (e) => {
    const entry = readEvent<JobHistoryEntry>(e);
    serverStateCache.invalidatePrefix('/v1/dashboard/jobs');
    serverStateCache.invalidatePrefix('/v1/dashboard/artifacts');
    serverStateCache.invalidatePrefix('/v1/dashboard/overview');
    liveState.historyAdditions = [entry, ...liveState.historyAdditions].slice(0, 200);
  });

  eventSource.addEventListener('presence', (e) => {
    liveState.onlineUsers = readEvent<string[]>(e);
  });

  eventSource.addEventListener('project-access-revoked', () => {
    eventSource.close();
    if (source !== eventSource) return;
    source = null;
    setProjectSelection('default');
    liveState.overview = null;
    liveState.logs = [];
    liveState.historyAdditions = [];
    serverStateCache.clear();
    liveState.overviewLoaded = false;
    lastSequence = 0;
    connectLive();
  });

  eventSource.onerror = () => {
    eventSource.close();
    if (source !== eventSource) return;
    source = null;
    liveState.connected = false;
    if (liveState.disconnectedAt === null) liveState.disconnectedAt = Date.now();
    liveState.stale = true;
    serverStateCache.markAllStale();
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
  serverStateCache.markAllStale();
  hasConnectedBefore = false;
  lastSequence = 0;
}

export function reconnectLive(resetProjectState = false): void {
  source?.close();
  source = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (resetProjectState) {
    liveState.overview = null;
    liveState.logs = [];
    liveState.historyAdditions = [];
    liveState.overviewLoaded = false;
    serverStateCache.invalidateAll();
  }
  connectLive();
}
