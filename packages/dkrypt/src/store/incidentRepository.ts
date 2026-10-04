import { randomUUID } from 'node:crypto';
import { config } from '#config.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getEffectiveDevices, getEffectiveWatches, getSchedulerRunHistory, hasSustainedDeviceHealthFailures } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { getRecentLogs } from '#logger.js';

export type IncidentStatus = 'open' | 'in_progress' | 'snoozed' | 'resolved';

export interface OperationalIncident {
  id: string;
  projectId: string;
  sourceKey: string;
  kind: 'job' | 'watch' | 'device' | 'deployment';
  title: string;
  detail: string;
  sourceId: string;
  status: IncidentStatus;
  recoveredAt?: number;
  assignedTo?: string;
  snoozedUntil?: number;
  resolutionNote?: string;
  createdAt: number;
  updatedAt: number;
  history: Array<{ at: number; actor: string; action: string; note?: string }>;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['operational_incidents']);

function fromRow(row: { payload: string } | null): OperationalIncident | undefined {
  return row ? JSON.parse(row.payload) as OperationalIncident : undefined;
}

function persist(incident: OperationalIncident): void {
  database.query('INSERT INTO operational_incidents (id, payload, updated_at, project_id, source_key, status) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, status = excluded.status').run(incident.id, JSON.stringify(incident), incident.updatedAt, incident.projectId, incident.sourceKey, incident.status);
}

export function openIncident(input: Pick<OperationalIncident, 'projectId' | 'sourceKey' | 'kind' | 'title' | 'detail' | 'sourceId'>): OperationalIncident {
  const existing = fromRow(database.query('SELECT payload FROM operational_incidents WHERE source_key = ?').get(input.sourceKey) as { payload: string } | null);
  if (existing) {
    if (!existing.recoveredAt && existing.status !== 'resolved') return existing;
    existing.status = 'open';
    existing.recoveredAt = undefined;
    existing.resolutionNote = undefined;
    existing.updatedAt = Date.now();
    existing.history.push({ at: existing.updatedAt, actor: 'system', action: 'reopened' });
    persist(existing);
    return existing;
  }
  const now = Date.now();
  const incident: OperationalIncident = { ...input, id: randomUUID(), status: 'open', createdAt: now, updatedAt: now, history: [{ at: now, actor: 'system', action: 'opened' }] };
  persist(incident);
  return incident;
}

export function recoverIncident(sourceKey: string): void {
  const incident = fromRow(database.query('SELECT payload FROM operational_incidents WHERE source_key = ?').get(sourceKey) as { payload: string } | null);
  if (!incident || incident.recoveredAt || incident.status === 'resolved') return;
  incident.recoveredAt = Date.now();
  incident.updatedAt = incident.recoveredAt;
  incident.history.push({ at: incident.updatedAt, actor: 'system', action: 'recovered' });
  persist(incident);
}

export function listOperationalIncidents(projectId: string): OperationalIncident[] {
  const now = Date.now();
  const rows = database.query('SELECT payload FROM operational_incidents WHERE project_id = ? ORDER BY updated_at DESC LIMIT 500').all(projectId) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as OperationalIncident).map((incident) => {
    if (incident.status !== 'snoozed' || !incident.snoozedUntil || incident.snoozedUntil > now) return incident;
    incident.status = 'open';
    incident.snoozedUntil = undefined;
    incident.updatedAt = now;
    incident.history.push({ at: now, actor: 'system', action: 'snooze_expired' });
    persist(incident);
    return incident;
  });
}

export function getOperationalIncidentStateAt(projectId: string, at: number): {
  coverage: 'recorded' | 'incomplete';
  coverageStartAt?: number;
  incidents: Array<Pick<OperationalIncident, 'id' | 'kind' | 'title' | 'sourceId' | 'status'> & { recovered: boolean }>;
} {
  const records = listOperationalIncidents(projectId);
  const coverageStartAt = records.reduce<number | undefined>((earliest, incident) => {
    const first = incident.history[0]?.at;
    return first === undefined ? earliest : Math.min(earliest ?? first, first);
  }, undefined);
  if (coverageStartAt === undefined || at < coverageStartAt) return { coverage: 'incomplete', coverageStartAt, incidents: [] };
  const incidents = records.flatMap((incident) => {
    const changes = incident.history.filter((change) => change.at <= at).sort((left, right) => left.at - right.at);
    if (changes.length === 0) return [];
    let status: IncidentStatus = 'open';
    let recovered = false;
    for (const change of changes) {
      if (change.action === 'opened' || change.action === 'reopened' || change.action === 'snooze_expired') status = 'open';
      if (change.action === 'in_progress' || change.action === 'snoozed' || change.action === 'resolved') status = change.action;
      if (change.action === 'recovered') recovered = true;
      if (change.action === 'reopened') recovered = false;
    }
    return [{ id: incident.id, kind: incident.kind, title: incident.title, sourceId: incident.sourceId, status, recovered }];
  });
  return { coverage: 'recorded', coverageStartAt, incidents };
}

export function updateOperationalIncident(id: string, projectId: string, actor: string, change: { status?: IncidentStatus; assignedTo?: string | null; snoozedUntil?: number; resolutionNote?: string }): OperationalIncident | undefined {
  const incident = fromRow(database.query('SELECT payload FROM operational_incidents WHERE id = ? AND project_id = ?').get(id, projectId) as { payload: string } | null);
  if (!incident) return undefined;
  if (change.status === 'snoozed' && (!change.snoozedUntil || change.snoozedUntil <= Date.now() || change.snoozedUntil > Date.now() + 30 * 24 * 60 * 60 * 1000)) throw new Error('choose a snooze time within 30 days');
  if (change.status === 'resolved' && !change.resolutionNote?.trim()) throw new Error('a resolution note is required');
  if (change.status) incident.status = change.status;
  if (change.assignedTo !== undefined) incident.assignedTo = change.assignedTo || undefined;
  if (change.status === 'snoozed') incident.snoozedUntil = change.snoozedUntil;
  if (change.status && change.status !== 'snoozed') incident.snoozedUntil = undefined;
  if (change.status === 'resolved') incident.resolutionNote = change.resolutionNote?.trim();
  incident.updatedAt = Date.now();
  incident.history.push({ at: incident.updatedAt, actor, action: change.status ?? 'assigned', note: change.resolutionNote });
  persist(incident);
  return incident;
}

export function reconcileOperationalIncidents(): void {
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  for (const job of getAllJobHistory()) {
    if (job.status !== 'failed' || (job.finishedAt ?? job.createdAt) < cutoff) continue;
    openIncident({ projectId: job.projectId ?? DEFAULT_PROJECT_ID, sourceKey: `job:${job.id}`, kind: 'job', sourceId: job.id, title: 'Decrypt failed', detail: job.bundleId });
  }
  const watches = new Map(getEffectiveWatches().map((watch) => [watch.id, watch]));
  const observedWatchSources = new Set<string>();
  for (const run of getSchedulerRunHistory(500).sort((left, right) => right.ts - left.ts)) {
    if (run.ts < cutoff || !run.watchId) continue;
    const watch = watches.get(run.watchId);
    if (!watch) continue;
    for (const source of ['appStore', 'testflight'] as const) {
      const outcome = run[source];
      const sourceKey = `watch:${watch.id}:${source}`;
      if (observedWatchSources.has(sourceKey)) continue;
      if (outcome.runStatus !== 'failed' && outcome.runStatus !== 'timed_out' && outcome.runStatus !== 'succeeded') continue;
      observedWatchSources.add(sourceKey);
      if (outcome.runStatus === 'failed' || outcome.runStatus === 'timed_out') openIncident({ projectId: watch.projectId ?? DEFAULT_PROJECT_ID, sourceKey, kind: 'watch', sourceId: watch.id, title: 'Watch run failed', detail: `${watch.bundleId} · ${outcome.failureSummary ?? outcome.reason}` });
      else if (outcome.runStatus === 'succeeded') recoverIncident(sourceKey);
    }
  }
  for (const device of getEffectiveDevices().filter((entry) => entry.enabled)) {
    const key = `device:${device.id}`;
    if (hasSustainedDeviceHealthFailures(device.id)) openIncident({ projectId: DEFAULT_PROJECT_ID, sourceKey: key, kind: 'device', sourceId: device.id, title: 'Device unavailable', detail: device.name });
    else recoverIncident(key);
  }
  for (const entry of getRecentLogs({ limit: 500 }).logs) {
    if (entry.ts < cutoff || entry.level !== 'error' || !/deploy/i.test(entry.scope)) continue;
    const deploymentId = typeof entry.meta?.deploymentId === 'string' ? entry.meta.deploymentId : typeof entry.meta?.runId === 'string' ? entry.meta.runId : undefined;
    if (!deploymentId) continue;
    openIncident({ projectId: DEFAULT_PROJECT_ID, sourceKey: `deployment:${deploymentId}`, kind: 'deployment', sourceId: deploymentId, title: 'Deployment failed', detail: entry.message });
  }
}

export function closeIncidentRepository(): void {
  database.close();
}
