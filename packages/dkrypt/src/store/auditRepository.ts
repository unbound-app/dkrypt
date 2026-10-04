import type { Database } from 'bun:sqlite';
import type { AuditLogEntry } from '#store/state.js';

export interface AuditRepository {
  listRecent(limit?: number): AuditLogEntry[];
  listByTarget(target: string, limit?: number): AuditLogEntry[];
  count(): number;
}

export function createAuditRepository(database: Database): AuditRepository {
  const recent = database.query('SELECT payload FROM audit_events ORDER BY occurred_at DESC, id DESC LIMIT ?;');
  const byTarget = database.query('SELECT payload FROM audit_events WHERE target = ? ORDER BY occurred_at DESC, id DESC LIMIT ?;');
  const count = database.query('SELECT COUNT(*) AS total FROM audit_events;');
  return {
    listRecent(limit = 200) {
      const rows = recent.all(Math.max(0, Math.floor(limit))) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as AuditLogEntry);
    },
    listByTarget(target, limit = 5) {
      const rows = byTarget.all(target, Math.max(0, Math.floor(limit))) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as AuditLogEntry);
    },
    count() {
      const result = count.get() as { total: number };
      return result.total;
    },
  };
}
