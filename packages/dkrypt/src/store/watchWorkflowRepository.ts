import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { config } from '#config.js';
import type { AppWatch, CreateWatchInput } from '#store/state.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

export interface WatchDraft {
  id: string;
  ownerId: string;
  projectId: string;
  input: Partial<CreateWatchInput>;
  updatedAt: number;
  expiresAt: number;
}

export interface WatchRevision {
  id: string;
  watchId: string;
  projectId: string;
  actor: string;
  at: number;
  action: 'created' | 'updated' | 'restored' | 'deleted';
  changedFields: string[];
  changes?: Array<{ field: string; before?: string; after?: string }>;
  snapshot: Omit<AppWatch, 'webhookUrl'> & { webhookConfigured: boolean };
  deletedAt?: number;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['watch_drafts', 'watch_revisions']);
const draftLifetime = 30 * 24 * 60 * 60 * 1000;
const deletedRevisionLifetime = 90 * 24 * 60 * 60 * 1000;

function cleanDraft(input: Partial<CreateWatchInput>): Partial<CreateWatchInput> {
  const { webhookUrl: _webhookUrl, ...safeInput } = input;
  return safeInput;
}

function parseRow<T>(row: { payload: string } | null): T | undefined {
  return row ? JSON.parse(row.payload) as T : undefined;
}

function snapshot(watch: AppWatch): WatchRevision['snapshot'] {
  const { webhookUrl, ...safeWatch } = watch;
  return { ...safeWatch, webhookConfigured: Boolean(webhookUrl) };
}

export function listWatchDrafts(ownerId: string, projectId: string): WatchDraft[] {
  database.query('DELETE FROM watch_drafts WHERE expires_at < ?').run(Date.now());
  const rows = database.query('SELECT payload FROM watch_drafts WHERE owner_id = ? AND project_id = ? ORDER BY updated_at DESC').all(ownerId, projectId) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as WatchDraft);
}

export function saveWatchDraft(ownerId: string, projectId: string, input: Partial<CreateWatchInput>, id: string = randomUUID()): WatchDraft {
  const existing = getWatchDraft(id);
  if (existing && (existing.ownerId !== ownerId || existing.projectId !== projectId)) throw new Error('watch draft is not accessible');
  const updatedAt = Date.now();
  const draft: WatchDraft = { id, ownerId, projectId, input: cleanDraft(input), updatedAt, expiresAt: updatedAt + draftLifetime };
  database.query('INSERT INTO watch_drafts (id, payload, updated_at, owner_id, project_id, expires_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, expires_at = excluded.expires_at').run(id, JSON.stringify(draft), updatedAt, ownerId, projectId, draft.expiresAt);
  return draft;
}

export function getWatchDraft(id: string): WatchDraft | undefined {
  const draft = parseRow<WatchDraft>(database.query('SELECT payload FROM watch_drafts WHERE id = ? AND expires_at >= ?').get(id, Date.now()) as { payload: string } | null);
  return draft;
}

export function deleteWatchDraft(id: string, ownerId: string): boolean {
  return database.query('DELETE FROM watch_drafts WHERE id = ? AND owner_id = ?').run(id, ownerId).changes > 0;
}

export function recordWatchRevision(watch: AppWatch, actor: string, action: WatchRevision['action'], previous?: AppWatch, transactionDatabase: Database = database): WatchRevision {
  const previousSafe = previous ? snapshot(previous) : undefined;
  const currentSafe = snapshot(watch);
  const changedFields = Object.keys(currentSafe).filter((field) => field !== 'updatedAt' && field !== 'lastScheduledAt' && JSON.stringify(currentSafe[field as keyof typeof currentSafe]) !== JSON.stringify(previousSafe?.[field as keyof typeof currentSafe]));
  const changes = changedFields.map((field) => ({ field, before: previousSafe?.[field as keyof typeof currentSafe] === undefined ? undefined : JSON.stringify(previousSafe[field as keyof typeof currentSafe]), after: currentSafe[field as keyof typeof currentSafe] === undefined ? undefined : JSON.stringify(currentSafe[field as keyof typeof currentSafe]) }));
  const at = Date.now();
  const revision: WatchRevision = { id: randomUUID(), watchId: watch.id, projectId: watch.projectId ?? 'default', actor, at, action, changedFields, changes, snapshot: currentSafe, ...(action === 'deleted' ? { deletedAt: at } : {}) };
  transactionDatabase.query('INSERT INTO watch_revisions (id, payload, updated_at, watch_id, project_id, deleted_at) VALUES (?, ?, ?, ?, ?, ?)').run(revision.id, JSON.stringify(revision), at, watch.id, revision.projectId, revision.deletedAt ?? null);
  if (action === 'deleted') transactionDatabase.query('UPDATE watch_revisions SET deleted_at = ? WHERE watch_id = ?').run(at, watch.id);
  return revision;
}

export function listWatchRevisions(watchId: string, projectId: string): WatchRevision[] {
  database.query('DELETE FROM watch_revisions WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(Date.now() - deletedRevisionLifetime);
  const rows = database.query('SELECT payload FROM watch_revisions WHERE watch_id = ? AND project_id = ? ORDER BY updated_at DESC').all(watchId, projectId) as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as WatchRevision);
}

export function getWatchRevision(id: string): WatchRevision | undefined {
  return parseRow<WatchRevision>(database.query('SELECT payload FROM watch_revisions WHERE id = ?').get(id) as { payload: string } | null);
}

export function closeWatchWorkflowRepository(): void {
  database.close();
}
