import type { Database } from 'bun:sqlite';
import type { ActiveSessionRecord } from '#store/state.js';

export interface SessionRepository {
  listAll(): ActiveSessionRecord[];
  listByUser(userId: string): ActiveSessionRecord[];
  findById(sessionId: string): ActiveSessionRecord | undefined;
  isActive(sessionId: string): boolean;
  create(record: ActiveSessionRecord, limit: number): void;
  revoke(sessionId: string, userId: string): boolean;
  revokeUser(userId: string): number;
  revokeOthers(userId: string, keepSessionId: string): number;
  deleteExpiredBefore(timestamp: number): number;
  touch(sessionId: string, lastSeenAt: number): boolean;
}

export function createSessionRepository(database: Database): SessionRepository {
  const listAll = database.query('SELECT payload FROM sessions ORDER BY rowid ASC;');
  const listByUser = database.query('SELECT payload FROM sessions WHERE user_id = lower(?) ORDER BY last_seen_at DESC, rowid ASC;');
  const findById = database.query('SELECT payload FROM sessions WHERE id = ?;');
  const activeById = database.query('SELECT 1 AS active FROM sessions WHERE id = ?;');
  const oldestForUser = database.query("SELECT id FROM sessions WHERE user_id = lower(?) AND json_extract(payload, '$.sub') = ? ORDER BY rowid ASC;");
  const insert = database.query('INSERT INTO sessions (id, payload, updated_at, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?);');
  const deleteById = database.query("DELETE FROM sessions WHERE id = ? AND user_id = lower(?) AND json_extract(payload, '$.sub') = ?;");
  const revokeUser = database.query("DELETE FROM sessions WHERE user_id = lower(?) AND json_extract(payload, '$.sub') = ?;");
  const revokeOthers = database.query("DELETE FROM sessions WHERE user_id = lower(?) AND json_extract(payload, '$.sub') = ? AND id <> ?;");
  const deleteExpiredBefore = database.query('DELETE FROM sessions WHERE last_seen_at <= ?;');
  const touch = database.query("UPDATE sessions SET payload = json_set(payload, '$.lastSeenAt', ?), updated_at = ?, last_seen_at = ? WHERE id = ?;");

  return {
    listAll() {
      return (listAll.all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as ActiveSessionRecord);
    },
    listByUser(userId) {
      return (listByUser.all(userId) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as ActiveSessionRecord);
    },
    findById(sessionId) {
      const row = findById.get(sessionId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as ActiveSessionRecord : undefined;
    },
    isActive(sessionId) {
      return activeById.get(sessionId) != null;
    },
    create(record, limit) {
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError('session limit must be a positive integer');
      database.exec('BEGIN IMMEDIATE;');
      try {
        const recordPayload = JSON.stringify(record);
        insert.run(record.id, recordPayload, record.lastSeenAt, record.sub.toLowerCase(), record.createdAt, record.lastSeenAt);
        const userRecords = oldestForUser.all(record.sub, record.sub) as Array<{ id: string }>;
        for (const expired of userRecords.slice(0, Math.max(0, userRecords.length - limit))) {
          deleteById.run(expired.id, record.sub, record.sub);
        }
        database.exec('COMMIT;');
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    },
    revoke(sessionId, userId) {
      return deleteById.run(sessionId, userId, userId).changes > 0;
    },
    revokeUser(userId) {
      return revokeUser.run(userId, userId).changes;
    },
    revokeOthers(userId, keepSessionId) {
      return revokeOthers.run(userId, userId, keepSessionId).changes;
    },
    deleteExpiredBefore(timestamp) {
      return deleteExpiredBefore.run(timestamp).changes;
    },
    touch(sessionId, lastSeenAt) {
      return touch.run(lastSeenAt, lastSeenAt, lastSeenAt, sessionId).changes > 0;
    },
  };
}
