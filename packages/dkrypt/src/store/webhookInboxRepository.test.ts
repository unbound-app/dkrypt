import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createWebhookInboxRepository } from '#store/webhookInboxRepository.js';
import type { WebhookInboxRecord } from '#webhookInbox.js';
import { openStateDatabase } from '#store/sqlite.js';

function webhookRecord(overrides: Partial<WebhookInboxRecord> = {}): WebhookInboxRecord {
  return {
    id: 'webhook-1',
    provider: 'stripe',
    eventId: 'evt-1',
    status: 'received',
    rawBody: '{"id":"evt-1"}',
    rawBodySha256: 'body-hash',
    receivedAt: 100,
    attempts: 0,
    ...overrides,
  };
}

test('webhook inbox repository deduplicates provider events atomically and preserves the first payload', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-webhook-inbox-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createWebhookInboxRepository(database.db);

  try {
    const original = webhookRecord();
    const first = repository.insertIfAbsent(original);
    const duplicate = repository.insertIfAbsent(webhookRecord({ id: 'webhook-2', rawBody: '{"id":"replacement"}', receivedAt: 200 }));
    const secondEvent = webhookRecord({ id: 'webhook-4', eventId: 'evt-2', receivedAt: 150 });
    repository.insertIfAbsent(secondEvent);
    const otherProvider = repository.insertIfAbsent(webhookRecord({ id: 'webhook-3', provider: 'nowpayments' }));

    expect(first).toEqual({ record: original, inserted: true });
    expect(duplicate).toEqual({ record: original, inserted: false });
    expect(otherProvider).toEqual({ record: webhookRecord({ id: 'webhook-3', provider: 'nowpayments' }), inserted: true });
    expect(repository.list()).toEqual([
      secondEvent,
      webhookRecord({ id: 'webhook-3', provider: 'nowpayments' }),
      original,
    ]);
    expect(repository.list({ provider: 'stripe' }, { limit: 1, offset: 1 })).toEqual([original]);
    expect(repository.count({ provider: 'stripe' })).toBe(2);
    expect(repository.findById('webhook-2')).toBeUndefined();
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('webhook inbox repository persists state and attempt updates across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-webhook-inbox-reopen-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let database: ReturnType<typeof openStateDatabase> | undefined = openStateDatabase(options);
  const repository = createWebhookInboxRepository(database.db);
  const processed = webhookRecord({
    status: 'processed',
    attempts: 2,
    processedAt: 250,
    lastError: undefined,
  });

  try {
    repository.insertIfAbsent(webhookRecord());
    repository.save(processed);
    database.close();
    database = undefined;

    const reopened = openStateDatabase(options);
    try {
      const reopenedRepository = createWebhookInboxRepository(reopened.db);
      expect(reopenedRepository.findById(processed.id)).toEqual(processed);
      expect(reopenedRepository.list({ status: 'processed', provider: 'stripe' })).toEqual([processed]);
      expect(reopened.db.query('SELECT id FROM webhook_attempts ORDER BY id').all()).toEqual([
        { id: 'webhook-1:0' },
        { id: 'webhook-1:2' },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    database?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('webhook inbox migration backfills indexed state from existing payloads', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-webhook-inbox-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const record = webhookRecord({ id: 'legacy-webhook', eventId: 'evt-legacy', receivedAt: 321, attempts: 1, status: 'failed', lastError: 'retry me' });

  try {
    existing.db.query('INSERT INTO webhook_inbox (id, payload, updated_at) VALUES (?, ?, ?)').run(record.id, JSON.stringify(record), record.receivedAt);
    for (const index of ['webhook_inbox_by_event', 'webhook_inbox_by_provider_time', 'webhook_inbox_by_status_time']) existing.db.exec(`DROP INDEX ${index};`);
    for (const column of ['last_error', 'attempts', 'processed_at', 'received_at', 'raw_body_sha256', 'status', 'event_id', 'provider']) existing.db.exec(`ALTER TABLE webhook_inbox DROP COLUMN ${column};`);
    existing.db.exec('DELETE FROM schema_migrations WHERE version = 16;');
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(17);
      expect(createWebhookInboxRepository(migrated.db).findById(record.id)).toEqual(record);
      expect(migrated.db.query('SELECT provider, event_id, status, received_at, attempts FROM webhook_inbox WHERE id = ?').get(record.id)).toEqual({
        provider: 'stripe',
        event_id: 'evt-legacy',
        status: 'failed',
        received_at: 321,
        attempts: 1,
      });
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
