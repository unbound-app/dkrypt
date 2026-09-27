import type { Database } from 'bun:sqlite';
import type { WebhookInboxRecord, WebhookInboxStatus } from '#webhookInbox.js';

export interface WebhookInboxRepositoryFilter {
  provider?: WebhookInboxRecord['provider'];
  status?: WebhookInboxStatus;
}

export interface WebhookInboxRepositoryPage {
  limit: number;
  offset: number;
}

export interface WebhookInboxRepository {
  findById(id: string): WebhookInboxRecord | undefined;
  findByProviderEvent(provider: WebhookInboxRecord['provider'], eventId: string): WebhookInboxRecord | undefined;
  insertIfAbsent(record: WebhookInboxRecord): { record: WebhookInboxRecord; inserted: boolean };
  save(record: WebhookInboxRecord): void;
  list(filter?: WebhookInboxRepositoryFilter, page?: WebhookInboxRepositoryPage): WebhookInboxRecord[];
  count(filter?: WebhookInboxRepositoryFilter): number;
}

function parseRecord(payload: string): WebhookInboxRecord {
  return JSON.parse(payload) as WebhookInboxRecord;
}

function attemptPayload(record: WebhookInboxRecord): { inboxId: string; attempt: number; status: WebhookInboxStatus; at: number; error?: string } {
  return {
    inboxId: record.id,
    attempt: record.attempts,
    status: record.status,
    at: record.processedAt ?? record.receivedAt,
    error: record.lastError,
  };
}

function insertAttempt(database: Database, record: WebhookInboxRecord): void {
  const at = record.processedAt ?? record.receivedAt;
  database.query(`
    INSERT INTO webhook_attempts (id, payload, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `).run(`${record.id}:${record.attempts}`, JSON.stringify(attemptPayload(record)), at);
}

function pruneOldRecords(database: Database): void {
  database.exec(`
    DELETE FROM webhook_inbox
    WHERE id IN (
      SELECT id FROM webhook_inbox
      ORDER BY received_at DESC, id DESC
      LIMIT -1 OFFSET 5000
    );
    DELETE FROM webhook_attempts
    WHERE json_extract(payload, '$.inboxId') NOT IN (SELECT id FROM webhook_inbox);
  `);
}

export function createWebhookInboxRepository(database: Database): WebhookInboxRepository {
  const byId = database.query('SELECT payload FROM webhook_inbox WHERE id = ?;');
  const byProviderEvent = database.query(`
    SELECT payload FROM webhook_inbox
    WHERE provider = ? AND event_id = ?
    ORDER BY received_at ASC, id ASC
    LIMIT 1;
  `);

  return {
    findById(id) {
      const row = byId.get(id) as { payload: string } | null;
      return row ? parseRecord(row.payload) : undefined;
    },
    findByProviderEvent(provider, eventId) {
      const row = byProviderEvent.get(provider, eventId) as { payload: string } | null;
      return row ? parseRecord(row.payload) : undefined;
    },
    insertIfAbsent(record) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const existing = this.findByProviderEvent(record.provider, record.eventId);
        if (existing) {
          database.exec('COMMIT;');
          return { record: existing, inserted: false };
        }
        database.query(`
          INSERT INTO webhook_inbox (
            id, payload, updated_at, provider, event_id, status, raw_body_sha256,
            received_at, processed_at, attempts, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
        `).run(
          record.id,
          JSON.stringify(record),
          record.processedAt ?? record.receivedAt,
          record.provider,
          record.eventId,
          record.status,
          record.rawBodySha256,
          record.receivedAt,
          record.processedAt ?? null,
          record.attempts,
          record.lastError ?? null,
        );
        insertAttempt(database, record);
        pruneOldRecords(database);
        database.exec('COMMIT;');
        return { record: { ...record }, inserted: true };
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    save(record) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        database.query(`
          UPDATE webhook_inbox
          SET payload = ?, updated_at = ?, provider = ?, event_id = ?, status = ?,
              raw_body_sha256 = ?, received_at = ?, processed_at = ?, attempts = ?, last_error = ?
          WHERE id = ?;
        `).run(
          JSON.stringify(record),
          record.processedAt ?? record.receivedAt,
          record.provider,
          record.eventId,
          record.status,
          record.rawBodySha256,
          record.receivedAt,
          record.processedAt ?? null,
          record.attempts,
          record.lastError ?? null,
          record.id,
        );
        insertAttempt(database, record);
        pruneOldRecords(database);
        database.exec('COMMIT;');
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    list(filter = {}, page) {
      const conditions: string[] = [];
      const parameters: string[] = [];
      if (filter.provider) {
        conditions.push('provider = ?');
        parameters.push(filter.provider);
      }
      if (filter.status) {
        conditions.push('status = ?');
        parameters.push(filter.status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const pagination = page ? 'LIMIT ? OFFSET ?' : '';
      const parametersWithPage = page
        ? [...parameters, Math.max(1, Math.floor(page.limit)), Math.max(0, Math.floor(page.offset))]
        : parameters;
      const rows = database.query(`
        SELECT payload FROM webhook_inbox ${where}
        ORDER BY received_at DESC, id DESC ${pagination};
      `).all(...parametersWithPage) as Array<{ payload: string }>;
      return rows.map((row) => parseRecord(row.payload));
    },
    count(filter = {}) {
      const conditions: string[] = [];
      const parameters: string[] = [];
      if (filter.provider) {
        conditions.push('provider = ?');
        parameters.push(filter.provider);
      }
      if (filter.status) {
        conditions.push('status = ?');
        parameters.push(filter.status);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const row = database.query(`SELECT count(*) AS total FROM webhook_inbox ${where};`).get(...parameters) as { total: number };
      return row.total;
    },
  };
}
