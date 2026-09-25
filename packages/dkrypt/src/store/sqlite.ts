import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';

type StateRecord = Record<string, unknown>;

interface StateSnapshotRow {
  payload: string;
  sha256: string;
}

interface DomainRow {
  id: string;
  payload: unknown;
  updatedAt?: number;
}

export interface StateCollectionReplacement {
  table: string;
  rows: Array<{ id: string; payload: unknown; updatedAt?: number }>;
}

export interface StateDatabaseOptions {
  stateDir: string;
  filename?: string;
  busyTimeoutMs?: number;
  migrationDryRun?: boolean;
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_snapshots (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state_version INTEGER NOT NULL,
        payload TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_health (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS job_timelines (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS watches (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_records (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS testflight_subscriptions (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_inbox (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS backups (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS idempotency_keys (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS auth_profiles (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS device_history (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS correlation_events (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS webhook_attempts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE INDEX IF NOT EXISTS artifacts_updated_at ON artifacts(updated_at);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS scheduler_runs (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO scheduler_runs (id, payload, updated_at)
      SELECT id, payload, updated_at
      FROM job_timelines
      WHERE json_valid(payload) = 1 AND json_extract(payload, '$.jobId') IS NULL
      ON CONFLICT(id) DO NOTHING;
      DELETE FROM job_timelines
      WHERE json_valid(payload) = 1 AND json_extract(payload, '$.jobId') IS NULL;
    `,
  },
] as const;

const domainTables = [
  'users',
  'roles',
  'sessions',
  'api_keys',
  'devices',
  'device_health',
  'jobs',
  'job_timelines',
  'artifacts',
  'watches',
  'notifications',
  'audit_events',
  'billing_records',
  'testflight_subscriptions',
  'webhook_inbox',
  'backups',
  'idempotency_keys',
  'settings',
  'scheduler_runs',
] as const;

const stateOwnedDomainTables = domainTables.filter(
  (table): table is Exclude<(typeof domainTables)[number], 'jobs' | 'billing_records' | 'artifacts' | 'idempotency_keys' | 'webhook_inbox'> =>
    table !== 'jobs' && table !== 'billing_records' && table !== 'artifacts' && table !== 'idempotency_keys' && table !== 'webhook_inbox',
);

const collectionTables = new Set([
  ...domainTables,
  'auth_profiles',
  'device_history',
  'billing_events',
  'correlation_events',
  'webhook_attempts',
]);

function assertCollectionTable(table: string): void {
  if (!collectionTables.has(table)) throw new Error(`unknown SQLite collection: ${table}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(temporaryPath, content, { mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, filePath);
}

function recordId(value: unknown, fallback: string): string {
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).id === 'string') return (value as StateRecord).id as string;
  return fallback;
}

function recordUpdatedAt(value: unknown): number {
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).updatedAt === 'number') return (value as StateRecord).updatedAt as number;
  if (typeof value === 'object' && value !== null && typeof (value as StateRecord).createdAt === 'number') return (value as StateRecord).createdAt as number;
  return Date.now();
}

function arrayRows(value: unknown, prefix: string): DomainRow[] {
  if (!Array.isArray(value)) return [];
  return value.map((payload, index) => ({ id: recordId(payload, `${prefix}-${index}`), payload, updatedAt: recordUpdatedAt(payload) }));
}

function objectRows(value: unknown, prefix: string): DomainRow[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as StateRecord).map(([key, payload]) => ({ id: `${prefix}-${key}`, payload: { key, value: payload }, updatedAt: recordUpdatedAt(payload) }));
}

function rowsForState(state: unknown): Record<(typeof domainTables)[number], DomainRow[]> {
  const value = state as StateRecord;
  const healthRows = objectRows(value.deviceHealthHistory, 'device-health');
  const settings = objectRows(value.settings, 'setting');
  return {
    users: arrayRows(value.allowedUsers, 'user'),
    roles: arrayRows(value.roles, 'role'),
    sessions: arrayRows(value.activeSessions, 'session'),
    api_keys: arrayRows(value.apiKeys, 'api-key'),
    devices: arrayRows(value.devices, 'device'),
    device_health: healthRows,
    jobs: [],
    job_timelines: [],
    scheduler_runs: arrayRows(value.schedulerRunHistory, 'scheduler-run'),
    artifacts: [],
    watches: arrayRows(value.watches, 'watch'),
    notifications: arrayRows(value.notifications, 'notification'),
    audit_events: arrayRows(value.auditLog, 'audit'),
    billing_records: [],
    testflight_subscriptions: arrayRows(value.testFlightSubscriptions, 'testflight'),
    webhook_inbox: arrayRows(value.webhookDeliveryLog, 'webhook'),
    backups: arrayRows(value.backupHistory, 'backup'),
    idempotency_keys: [],
    settings,
  };
}

function applyPragmas(db: Database, busyTimeoutMs: number): void {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Math.max(1, Math.floor(busyTimeoutMs))};`);
  db.exec('PRAGMA synchronous = FULL;');
}

function migrationRows(db: Database): Array<{ version: number; checksum: string }> {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at INTEGER NOT NULL);');
  return db.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
}

function backupBeforeMigrations(db: Database, databasePath: string, stateDir: string): void {
  const applied = migrationRows(db);
  const pending = migrations.some((migration) => !applied.some((row) => row.version === migration.version));
  if (!pending || !existsSync(databasePath)) return;
  const backupDir = path.join(stateDir, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const destination = path.join(backupDir, `pre-migration-${Date.now()}.sqlite`);
  db.query('VACUUM INTO ?').run(destination);
  chmodSync(destination, 0o600);
}

function applyMigrations(db: Database, dryRun: boolean): void {
  const appliedRows = migrationRows(db);
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row.checksum]));
  const pending = migrations.filter((migration) => {
    const applied = appliedByVersion.get(migration.version);
    if (applied && applied !== sha256(migration.sql)) throw new Error(`SQLite migration checksum mismatch for version ${migration.version}`);
    return !applied;
  });
  if (pending.length === 0) return;
  if (dryRun) {
    db.exec('BEGIN IMMEDIATE;');
    try {
      for (const migration of pending) {
        db.exec(migration.sql);
        db.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, sha256(migration.sql), Date.now());
      }
    } finally {
      db.exec('ROLLBACK;');
    }
    throw new Error(`SQLite migration dry run completed; ${pending.length} migration(s) were not applied`);
  }
  for (const migration of migrations) {
    const checksum = sha256(migration.sql);
    const applied = appliedByVersion.get(migration.version);
    if (applied && applied !== checksum) throw new Error(`SQLite migration checksum mismatch for version ${migration.version}`);
    if (applied) continue;
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(migration.sql);
      db.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)').run(migration.version, checksum, Date.now());
      db.exec('COMMIT;');
    } catch (error) {
      db.exec('ROLLBACK;');
      throw error;
    }
  }
}

function verifyIntegrity(db: Database): void {
  const row = db.query('PRAGMA integrity_check;').get() as { integrity_check?: string } | null;
  if (row?.integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${row?.integrity_check ?? 'unknown result'}`);
}

export class StateDatabase {
  readonly db: Database;
  readonly path: string;

  constructor(options: StateDatabaseOptions) {
    mkdirSync(options.stateDir, { recursive: true });
    this.path = path.join(options.stateDir, options.filename ?? 'dkrypt.sqlite');
    const existed = existsSync(this.path);
    this.db = new Database(this.path, { create: true, strict: true });
    try {
      applyPragmas(this.db, options.busyTimeoutMs ?? 5000);
      verifyIntegrity(this.db);
      if (existed) backupBeforeMigrations(this.db, this.path, options.stateDir);
      applyMigrations(this.db, options.migrationDryRun ?? false);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    const row = this.db.query('SELECT MAX(version) AS version FROM schema_migrations').get() as { version?: number } | null;
    return row?.version ?? 0;
  }

  integrityStatus(): 'ok' {
    verifyIntegrity(this.db);
    return 'ok';
  }

  readState(): unknown | undefined {
    const row = this.db.query('SELECT payload, sha256 FROM state_snapshots WHERE id = 1').get() as StateSnapshotRow | null;
    if (!row) return undefined;
    if (sha256(row.payload) !== row.sha256) throw new Error('SQLite state snapshot checksum mismatch');
    return JSON.parse(row.payload) as unknown;
  }

  writeState(state: unknown, legacyMirrorPath?: string): void {
    const payload = json(state);
    const checksum = sha256(payload);
    const stateVersion = typeof state === 'object' && state !== null && typeof (state as StateRecord).version === 'number' ? (state as StateRecord).version as number : 0;
    const rows = rowsForState(state);
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      this.db.query(`
        INSERT INTO state_snapshots (id, state_version, payload, sha256, updated_at)
        VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET state_version = excluded.state_version, payload = excluded.payload, sha256 = excluded.sha256, updated_at = excluded.updated_at
      `).run(stateVersion, payload, checksum, Date.now());
      for (const table of stateOwnedDomainTables) {
        this.db.exec(`DELETE FROM ${table};`);
        const statement = this.db.query(`INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?);`);
        for (const row of rows[table]) statement.run(row.id, json(row.payload), row.updatedAt ?? Date.now());
      }
      this.db.exec('COMMIT;');
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
    if (legacyMirrorPath) atomicWriteJson(legacyMirrorPath, state);
  }

  backupTo(destination: string): void {
    if (existsSync(destination)) throw new Error(`backup destination already exists: ${destination}`);
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${process.pid}.tmp`;
    rmSync(temporaryPath, { force: true });
    this.db.query('VACUUM INTO ?').run(temporaryPath);
    const backup = new Database(temporaryPath, { create: false, strict: true });
    try {
      applyPragmas(backup, 5000);
      verifyIntegrity(backup);
    } finally {
      backup.close();
    }
    renameSync(temporaryPath, destination);
    chmodSync(destination, 0o600);
  }

  readCollection(table: string): unknown[] {
    assertCollectionTable(table);
    const rows = this.db.query(`SELECT payload FROM ${table} ORDER BY updated_at DESC`).all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as unknown);
  }

  replaceCollection(table: string, rows: Array<{ id: string; payload: unknown; updatedAt?: number }>): void {
    replaceStateCollections(this.db, [{ table, rows }]);
  }

  close(): void {
    this.db.close();
  }
}

export function openStateCollectionDatabase(options: StateDatabaseOptions, tables: readonly string[]): Database {
  mkdirSync(options.stateDir, { recursive: true });
  const databasePath = path.join(options.stateDir, options.filename ?? 'dkrypt.sqlite');
  const existed = existsSync(databasePath);
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    applyPragmas(database, options.busyTimeoutMs ?? 5000);
    verifyIntegrity(database);
    if (existed) backupBeforeMigrations(database, databasePath, options.stateDir);
    applyMigrations(database, options.migrationDryRun ?? false);
    for (const table of tables) {
      assertCollectionTable(table);
      database.exec(`CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);`);
    }
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function readStateCollection(database: Database, table: string): unknown[] {
  assertCollectionTable(table);
  const rows = database.query(`SELECT payload FROM ${table} ORDER BY updated_at DESC`).all() as Array<{ payload: string }>;
  return rows.map((row) => JSON.parse(row.payload) as unknown);
}

export function replaceStateCollection(database: Database, table: string, rows: Array<{ id: string; payload: unknown; updatedAt?: number }>): void {
  replaceStateCollections(database, [{ table, rows }]);
}

export function replaceStateCollections(database: Database, replacements: readonly StateCollectionReplacement[]): void {
  const tables = new Set<string>();
  for (const replacement of replacements) {
    assertCollectionTable(replacement.table);
    if (tables.has(replacement.table)) throw new Error(`duplicate SQLite collection update: ${replacement.table}`);
    tables.add(replacement.table);
  }
  if (replacements.length === 0) return;
  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const replacement of replacements) {
      database.exec(`DELETE FROM ${replacement.table};`);
      const statement = database.query(`INSERT INTO ${replacement.table} (id, payload, updated_at) VALUES (?, ?, ?);`);
      for (const row of replacement.rows) statement.run(row.id, json(row.payload), row.updatedAt ?? Date.now());
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function openStateDatabase(options: StateDatabaseOptions): StateDatabase {
  return new StateDatabase(options);
}

export function verifyDatabaseBackup(databasePath: string): { schemaVersion: number; integrity: 'ok'; hasStateSnapshot: boolean } {
  if (!existsSync(databasePath)) throw new Error(`SQLite backup does not exist: ${databasePath}`);
  const database = new Database(databasePath, { create: false, strict: true });
  try {
    verifyIntegrity(database);
    const table = database.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() as { name?: string } | null;
    if (table?.name !== 'schema_migrations') throw new Error('SQLite backup is missing schema migration records');
    const applied = database.query('SELECT version, checksum FROM schema_migrations ORDER BY version').all() as Array<{ version: number; checksum: string }>;
    for (const migration of migrations) {
      const checksum = applied.find((row) => row.version === migration.version)?.checksum;
      if (checksum !== sha256(migration.sql)) throw new Error(`SQLite backup migration checksum mismatch for version ${migration.version}`);
    }
    const snapshot = database.query('SELECT 1 AS present FROM state_snapshots WHERE id = 1').get() as { present?: number } | null;
    return { schemaVersion: Math.max(...applied.map((row) => row.version), 0), integrity: 'ok', hasStateSnapshot: snapshot?.present === 1 };
  } finally {
    database.close();
  }
}
