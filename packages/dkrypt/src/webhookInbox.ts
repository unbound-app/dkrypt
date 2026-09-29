import { createHash, randomUUID } from 'node:crypto';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createWebhookInboxRepository, type WebhookInboxRepositoryFilter, type WebhookInboxRepositoryPage } from '#store/webhookInboxRepository.js';
import { config } from '#config.js';
import { incrementMetric, observeMetric } from '#metrics.js';

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
const repository = createWebhookInboxRepository(database);
const claimedRecords = new Set<string>();
const claimStartedAt = new Map<string, number>();

for (const record of repository.list()) if (!isWebhookInboxRecord(record)) throw new Error('webhook inbox record is malformed');

function isWebhookInboxRecord(value: unknown): value is WebhookInboxRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && (record.provider === 'stripe' || record.provider === 'nowpayments') && typeof record.eventId === 'string' && ['received', 'processed', 'failed', 'quarantined'].includes(String(record.status)) && typeof record.rawBody === 'string' && typeof record.rawBodySha256 === 'string' && typeof record.receivedAt === 'number' && typeof record.attempts === 'number';
}

export function receiveWebhook(provider: WebhookInboxRecord['provider'], eventId: string, rawBody: Buffer | string): { record: WebhookInboxRecord; duplicate: boolean } {
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
  const result = repository.insertIfAbsent(record);
  if (!result.inserted) {
    incrementMetric('webhook_events_duplicate_total', { provider });
    return { record: result.record, duplicate: true };
  }
  incrementMetric('webhook_events_received_total', { provider });
  return { record: result.record, duplicate: false };
}

export function claimWebhook(id: string, options: { allowQuarantined?: boolean; allowProcessed?: boolean } = {}): boolean {
  const record = repository.findById(id);
  if (!record || (record.status === 'processed' && !options.allowProcessed) || (record.status === 'quarantined' && !options.allowQuarantined) || claimedRecords.has(id)) {
    if (record) incrementMetric('webhook_claim_conflicts_total', { provider: record.provider });
    return false;
  }
  claimedRecords.add(id);
  claimStartedAt.set(id, Date.now());
  return true;
}

export function releaseWebhookClaim(id: string): void {
  claimedRecords.delete(id);
  claimStartedAt.delete(id);
}

export function markWebhookProcessed(id: string): WebhookInboxRecord | undefined {
  const record = repository.findById(id);
  if (!record) return undefined;
  record.status = 'processed';
  record.attempts += 1;
  record.processedAt = Date.now();
  record.lastError = undefined;
  repository.save(record);
  incrementMetric('webhook_events_reconciled_total', { provider: record.provider });
  const startedAt = claimStartedAt.get(id);
  if (startedAt !== undefined) observeMetric('webhook_reconciliation_duration_ms', Math.max(0, record.processedAt - startedAt), { provider: record.provider, outcome: 'success' });
  return record;
}

export function markWebhookFailed(id: string, error: string): WebhookInboxRecord | undefined {
  const record = repository.findById(id);
  if (!record) return undefined;
  record.status = 'failed';
  record.attempts += 1;
  record.lastError = error.slice(0, 500);
  repository.save(record);
  incrementMetric('webhook_reconciliation_failures_total', { provider: record.provider });
  const startedAt = claimStartedAt.get(id);
  if (startedAt !== undefined) observeMetric('webhook_reconciliation_duration_ms', Math.max(0, Date.now() - startedAt), { provider: record.provider, outcome: 'failure' });
  return record;
}

export function quarantineWebhook(id: string, reason: string): WebhookInboxRecord | undefined {
  const record = repository.findById(id);
  if (!record || record.status === 'processed' || claimedRecords.has(id)) return undefined;
  record.status = 'quarantined';
  record.lastError = reason.slice(0, 500);
  repository.save(record);
  incrementMetric('webhook_events_quarantined_total', { provider: record.provider });
  return record;
}

export function listWebhookInbox(filter?: WebhookInboxRepositoryFilter, page?: WebhookInboxRepositoryPage): WebhookInboxRecord[] {
  return repository.list(filter, page);
}

export function countWebhookInbox(filter?: WebhookInboxRepositoryFilter): number {
  return repository.count(filter);
}

export function getWebhookInboxRecord(id: string): WebhookInboxRecord | undefined {
  return repository.findById(id);
}

export function closeWebhookInboxDatabase(): void {
  claimedRecords.clear();
  database.close();
}
