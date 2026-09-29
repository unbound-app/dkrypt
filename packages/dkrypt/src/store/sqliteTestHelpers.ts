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

export function rewindApiKeySearchMigration(database: Database): void {
  database.exec(`
    DROP INDEX IF EXISTS api_keys_by_owner_created;
    DROP INDEX IF EXISTS api_keys_by_status_created;
    DROP INDEX IF EXISTS api_keys_by_current_hash;
    DROP INDEX IF EXISTS api_keys_by_previous_hash;
    DROP INDEX IF EXISTS api_keys_by_expiry;
    ALTER TABLE api_keys DROP COLUMN expires_at;
    ALTER TABLE api_keys DROP COLUMN created_at;
    ALTER TABLE api_keys DROP COLUMN previous_hash_expires_at;
    ALTER TABLE api_keys DROP COLUMN previous_hash;
    ALTER TABLE api_keys DROP COLUMN key_hash;
    ALTER TABLE api_keys DROP COLUMN status;
    ALTER TABLE api_keys DROP COLUMN owner_id;
  `);
}
