import type { Database } from 'bun:sqlite';

export type DiagnosticReportStatus = 'received';

export interface DiagnosticReportRecord {
  id: string;
  userId: string;
  projectId: string;
  category: 'bug' | 'device' | 'job' | 'other';
  summary: string;
  details: string;
  createdAt: number;
  expiresAt: number;
  status: DiagnosticReportStatus;
}

export interface DiagnosticReportRepository {
  create(report: DiagnosticReportRecord): void;
  listByUser(userId: string, limit: number): DiagnosticReportRecord[];
  listRecent(limit: number): DiagnosticReportRecord[];
  pruneExpired(now: number): number;
  close(): void;
}

export function createDiagnosticReportRepository(database: Database): DiagnosticReportRepository {
  const insert = database.query(`
    INSERT INTO diagnostic_reports (id, payload, updated_at, user_id, project_id, created_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byUser = database.query('SELECT payload FROM diagnostic_reports WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?');
  const recent = database.query('SELECT payload FROM diagnostic_reports ORDER BY created_at DESC, id DESC LIMIT ?');
  const removeExpired = database.query('DELETE FROM diagnostic_reports WHERE expires_at <= ?');

  return {
    create(report) {
      insert.run(report.id, JSON.stringify(report), report.createdAt, report.userId, report.projectId, report.createdAt, report.expiresAt, report.status);
    },
    listByUser(userId, limit) {
      return (byUser.all(userId, Math.max(0, Math.floor(limit))) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as DiagnosticReportRecord);
    },
    listRecent(limit) {
      return (recent.all(Math.max(0, Math.floor(limit))) as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as DiagnosticReportRecord);
    },
    pruneExpired(now) {
      return removeExpired.run(now).changes;
    },
    close() {
      database.close();
    },
  };
}
