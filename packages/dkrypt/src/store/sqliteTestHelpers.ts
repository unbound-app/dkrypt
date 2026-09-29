import type { Database } from 'bun:sqlite';

export function rewindSessionSearchMigration(database: Database): void {
  database.exec(`
    DROP INDEX IF EXISTS sessions_by_user_last_seen;
    DROP INDEX IF EXISTS sessions_by_expiry;
    ALTER TABLE sessions DROP COLUMN user_id;
    ALTER TABLE sessions DROP COLUMN created_at;
    ALTER TABLE sessions DROP COLUMN last_seen_at;
  `);
}
