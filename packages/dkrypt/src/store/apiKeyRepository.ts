import type { Database } from 'bun:sqlite';
import type { ApiKeyRecord } from '#store/state.js';
import type { StateCollectionReplacement } from '#store/sqlite.js';

export interface ApiKeyRepositoryPage {
  records: ApiKeyRecord[];
  total: number;
}

export interface ApiKeyRepository {
  listAll(): ApiKeyRecord[];
  listByOwner(ownerId: string): ApiKeyRecord[];
  listPending(): ApiKeyRecord[];
  findById(id: string): ApiKeyRecord | undefined;
  findApprovedByHash(hash: string, now: number): ApiKeyRecord | undefined;
  listPage(offset: number, limit: number, search?: string): ApiKeyRepositoryPage;
  replaceAll(records: ApiKeyRecord[]): void;
  collectionReplacement(records: ApiKeyRecord[]): StateCollectionReplacement;
  touchLastUsed(id: string, lastUsedAt: number, ip?: string): ApiKeyRecord | undefined;
}

export function isApiKeyRecordShape(value: unknown): value is ApiKeyRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<ApiKeyRecord>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.name === 'string'
    && typeof record.ownerId === 'string'
    && (record.status === 'pending' || record.status === 'approved' || record.status === 'denied')
    && typeof record.createdAt === 'number'
    && (record.hash === undefined || typeof record.hash === 'string')
    && (record.previousHash === undefined || typeof record.previousHash === 'string')
    && (record.previousHashExpiresAt === undefined || typeof record.previousHashExpiresAt === 'number')
    && (record.expiresAt === undefined || typeof record.expiresAt === 'number')
    && (record.allowedBundleIds === undefined || (Array.isArray(record.allowedBundleIds) && record.allowedBundleIds.every((bundleId) => typeof bundleId === 'string')));
}

export function createApiKeyRepository(database: Database): ApiKeyRepository {
  const listAllQuery = database.query('SELECT payload FROM api_keys ORDER BY rowid ASC;');
  const listByOwnerQuery = database.query('SELECT payload FROM api_keys WHERE owner_id = lower(?) ORDER BY rowid ASC;');
  const listPendingQuery = database.query("SELECT payload FROM api_keys WHERE status = 'pending' ORDER BY rowid ASC;");
  const findByIdQuery = database.query('SELECT payload FROM api_keys WHERE id = ?;');
  const findApprovedHashQuery = database.query(`
    SELECT payload FROM api_keys
    WHERE status = 'approved' AND (
      (key_hash = ? AND (expires_at IS NULL OR expires_at = 0 OR expires_at >= ?))
      OR (previous_hash = ? AND previous_hash_expires_at > ? AND (expires_at IS NULL OR expires_at = 0 OR expires_at >= ?))
    )
    ORDER BY rowid ASC
    LIMIT 1;
  `);
  const saveQuery = database.query(`
    INSERT INTO api_keys (id, payload, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at;
  `);
  const touchLastUsedQuery = database.query(`
    UPDATE api_keys SET payload = json_set(payload, '$.lastUsedAt', ?), updated_at = ?
    WHERE id = ?;
  `);
  const touchLastUsedWithIpQuery = database.query(`
    UPDATE api_keys SET payload = json_set(payload, '$.lastUsedAt', ?, '$.lastUsedIp', ?), updated_at = ?
    WHERE id = ?;
  `);
  const deleteAllQuery = database.query('DELETE FROM api_keys;');

  function parse(payload: string): ApiKeyRecord {
    const value: unknown = JSON.parse(payload);
    if (!isApiKeyRecordShape(value)) throw new Error('persisted API key record is malformed');
    return { ...value, allowedBundleIds: value.allowedBundleIds ? [...value.allowedBundleIds] : undefined };
  }

  function parseRows(rows: Array<{ payload: string }>): ApiKeyRecord[] {
    return rows.map(({ payload }) => parse(payload));
  }

  function findById(id: string): ApiKeyRecord | undefined {
    const row = findByIdQuery.get(id) as { payload: string } | null;
    return row ? parse(row.payload) : undefined;
  }

  function updatedAt(record: ApiKeyRecord): number {
    return record.lastUsedAt ?? record.createdAt;
  }

  function save(record: ApiKeyRecord): void {
    if (!isApiKeyRecordShape(record)) throw new TypeError('API key record is malformed');
    saveQuery.run(record.id, JSON.stringify(record), updatedAt(record));
  }

  function replaceAll(records: ApiKeyRecord[]): void {
    const ids = new Set<string>();
    for (const record of records) {
      if (!isApiKeyRecordShape(record)) throw new TypeError('API key record is malformed');
      if (ids.has(record.id)) throw new TypeError(`duplicate API key record: ${record.id}`);
      ids.add(record.id);
    }
    database.exec('BEGIN IMMEDIATE;');
    try {
      deleteAllQuery.run();
      for (const record of records) save(record);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  return {
    listAll() {
      return parseRows(listAllQuery.all() as Array<{ payload: string }>);
    },
    listByOwner(ownerId) {
      return parseRows(listByOwnerQuery.all(ownerId) as Array<{ payload: string }>);
    },
    listPending() {
      return parseRows(listPendingQuery.all() as Array<{ payload: string }>);
    },
    findById,
    findApprovedByHash(hash, now) {
      const row = findApprovedHashQuery.get(hash, now, hash, now, now) as { payload: string } | null;
      return row ? parse(row.payload) : undefined;
    },
    listPage(offset, limit, search = '') {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('API key page offset must be a non-negative integer');
      if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('API key page limit must be a positive integer');
      const needle = search.trim().toLowerCase();
      const matches = parseRows(listAllQuery.all() as Array<{ payload: string }>).filter((record) =>
        !needle || record.name.toLowerCase().includes(needle) || record.ownerId.toLowerCase().includes(needle),
      );
      matches.sort((left, right) => right.createdAt - left.createdAt);
      return { records: matches.slice(offset, offset + limit), total: matches.length };
    },
    replaceAll,
    collectionReplacement(records) {
      return {
        table: 'api_keys',
        rows: records.map((record) => ({ id: record.id, payload: record, updatedAt: updatedAt(record) })),
      };
    },
    touchLastUsed(id, lastUsedAt, ip) {
      const result = ip
        ? touchLastUsedWithIpQuery.run(lastUsedAt, ip, lastUsedAt, id)
        : touchLastUsedQuery.run(lastUsedAt, lastUsedAt, id);
      return result.changes > 0 ? findById(id) : undefined;
    },
  };
}
