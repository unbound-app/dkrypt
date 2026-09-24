import { createHash, randomUUID } from 'node:crypto';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { config } from '#config.js';

export type WebhookInboxStatus = 'received' | 'processed' | 'failed' | 'quarantined';

export interface WebhookInboxRecord {
  id: string;
  provider: 'stripe' | 'nowpayments';
  eventId: string;
  status: WebhookInboxStatus;
  rawBody: string;
  rawBodySha256: string;
  receivedAt: number;
  processedAt?: number;
  attempts: number;
  lastError?: string;
}

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['webhook_inbox', 'webhook_attempts']);
const records = new Map<string, WebhookInboxRecord>();

for (const value of readStateCollection(database, 'webhook_inbox')) {
  if (!isWebhookInboxRecord(value)) throw new Error('webhook inbox record is malformed');
  records.set(value.id, value);
}

function isWebhookInboxRecord(value: unknown): value is WebhookInboxRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && (record.provider === 'stripe' || record.provider === 'nowpayments') && typeof record.eventId === 'string' && ['received', 'processed', 'failed', 'quarantined'].includes(String(record.status)) && typeof record.rawBody === 'string' && typeof record.rawBodySha256 === 'string' && typeof record.receivedAt === 'number' && typeof record.attempts === 'number';
}

function persist(): void {
  const values = [...records.values()].sort((a, b) => b.receivedAt - a.receivedAt).slice(0, 5000);
  replaceStateCollection(database, 'webhook_inbox', values.map((record) => ({ id: record.id, payload: record, updatedAt: record.processedAt ?? record.receivedAt })));
  replaceStateCollection(database, 'webhook_attempts', values.map((record) => ({ id: `${record.id}:${record.attempts}`, payload: { inboxId: record.id, attempt: record.attempts, status: record.status, at: record.processedAt ?? record.receivedAt, error: record.lastError }, updatedAt: record.processedAt ?? record.receivedAt })));
}

export function receiveWebhook(provider: WebhookInboxRecord['provider'], eventId: string, rawBody: Buffer | string): { record: WebhookInboxRecord; duplicate: boolean } {
  const existing = [...records.values()].find((record) => record.provider === provider && record.eventId === eventId);
  if (existing) return { record: existing, duplicate: true };
  const body = rawBody.toString('utf8');
  const record: WebhookInboxRecord = {
    id: randomUUID(),
    provider,
    eventId,
    status: 'received',
    rawBody: body,
    rawBodySha256: createHash('sha256').update(body).digest('hex'),
    receivedAt: Date.now(),
    attempts: 0,
  };
  records.set(record.id, record);
  persist();
  return { record, duplicate: false };
}

export function markWebhookProcessed(id: string): WebhookInboxRecord | undefined {
  const record = records.get(id);
  if (!record) return undefined;
  record.status = 'processed';
  record.attempts += 1;
  record.processedAt = Date.now();
  record.lastError = undefined;
  persist();
  return record;
}

export function markWebhookFailed(id: string, error: string): WebhookInboxRecord | undefined {
  const record = records.get(id);
  if (!record) return undefined;
  record.status = 'failed';
  record.attempts += 1;
  record.lastError = error.slice(0, 500);
  persist();
  return record;
}

export function quarantineWebhook(id: string, reason: string): WebhookInboxRecord | undefined {
  const record = records.get(id);
  if (!record) return undefined;
  record.status = 'quarantined';
  record.lastError = reason.slice(0, 500);
  persist();
  return record;
}

export function listWebhookInbox(): WebhookInboxRecord[] {
  return [...records.values()].sort((a, b) => b.receivedAt - a.receivedAt).map((record) => ({ ...record }));
}

export function getWebhookInboxRecord(id: string): WebhookInboxRecord | undefined {
  const record = records.get(id);
  return record ? { ...record } : undefined;
}

export function closeWebhookInboxDatabase(): void {
  database.close();
}
