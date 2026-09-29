import type { Database } from 'bun:sqlite';
import type { IdempotencyRecord } from '#idempotency.js';

export interface IdempotencyRepository {
  find(scope: string, key: string): IdempotencyRecord | undefined;
  list(): IdempotencyRecord[];
  save(record: IdempotencyRecord): void;
  delete(scope: string, key: string): void;
  importLegacySnapshot(loadRecords: () => IdempotencyRecord[]): boolean;
  close(): void;
}

const legacyImportMarker = 'idempotency_json_imported';

export function isIdempotencyRecord(value: unknown): value is IdempotencyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<IdempotencyRecord>;
  return typeof record.scope === 'string'
    && record.scope.length > 0
    && typeof record.key === 'string'
    && record.key.length > 0
    && typeof record.fingerprint === 'string'
    && typeof record.jobId === 'string'
    && typeof record.expiresAt === 'number'
    && Number.isFinite(record.expiresAt);
}

export function idempotencyRecordId(scope: string, key: string): string {
  return `${scope}:${key}`;
}

export function createIdempotencyRepository(database: Database): IdempotencyRepository {
  const findQuery = database.query('SELECT payload FROM idempotency_keys WHERE id = ?;');
  const listQuery = database.query('SELECT payload FROM idempotency_keys ORDER BY updated_at DESC, id ASC;');
  const saveQuery = database.query(`
    INSERT INTO idempotency_keys (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `);
  const importQuery = database.query(`
    INSERT INTO idempotency_keys (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO NOTHING;
  `);
  const findMarkerQuery = database.query('SELECT value FROM metadata WHERE key = ?;');
  const countRecordsQuery = database.query('SELECT count(*) AS total FROM idempotency_keys;');
  const saveMarkerQuery = database.query(`
    INSERT INTO metadata (key, value) VALUES (?, '1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value;
  `);

  function parse(payload: string): IdempotencyRecord {
    const value: unknown = JSON.parse(payload);
    if (!isIdempotencyRecord(value)) throw new Error('persisted idempotency record is malformed');
    return value;
  }

  return {
    find(scope, key) {
      const row = findQuery.get(idempotencyRecordId(scope, key)) as { payload: string } | null;
      return row ? parse(row.payload) : undefined;
    },
    list() {
      const rows = listQuery.all() as Array<{ payload: string }>;
      return rows.map(({ payload }) => parse(payload));
    },
    save(record) {
      if (!isIdempotencyRecord(record)) throw new Error('idempotency record is malformed');
      saveQuery.run(idempotencyRecordId(record.scope, record.key), JSON.stringify(record), record.expiresAt);
    },
    delete(scope, key) {
      database.query('DELETE FROM idempotency_keys WHERE id = ?;').run(idempotencyRecordId(scope, key));
    },
    importLegacySnapshot(loadRecords) {
      database.exec('BEGIN IMMEDIATE;');
      try {
        const imported = findMarkerQuery.get(legacyImportMarker) as { value: string } | null;
        if (imported) {
          database.exec('COMMIT;');
          return false;
        }
        const row = countRecordsQuery.get() as { total: number };
        if (row.total === 0) {
          for (const record of loadRecords()) {
            if (!isIdempotencyRecord(record)) throw new Error('legacy idempotency record is malformed');
            importQuery.run(idempotencyRecordId(record.scope, record.key), JSON.stringify(record), record.expiresAt);
          }
        }
        saveMarkerQuery.run(legacyImportMarker);
        database.exec('COMMIT;');
        return true;
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    close() {
      database.close();
    },
  };
}
