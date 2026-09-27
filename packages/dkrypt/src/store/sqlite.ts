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
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
    `,
  },
  {
    version: 6,
    sql: `
      UPDATE jobs
      SET payload = json_set(payload, '$.projectId', 'default')
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectId') IS NULL;
      UPDATE artifacts
      SET payload = json_set(payload, '$.projectIds', json_array('default'))
      WHERE json_valid(payload) = 1 AND json_type(payload, '$.projectIds') IS NULL;
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE jobs ADD COLUMN status TEXT;
      ALTER TABLE jobs ADD COLUMN bundle_id TEXT;
      ALTER TABLE jobs ADD COLUMN external_version_id TEXT;
      ALTER TABLE jobs ADD COLUMN testflight_build_id INTEGER;
      ALTER TABLE jobs ADD COLUMN project_id TEXT;
      ALTER TABLE jobs ADD COLUMN source TEXT;
      ALTER TABLE jobs ADD COLUMN priority INTEGER;
      ALTER TABLE jobs ADD COLUMN created_at INTEGER;
      ALTER TABLE jobs ADD COLUMN started_at INTEGER;
      ALTER TABLE jobs ADD COLUMN finished_at INTEGER;
      ALTER TABLE jobs ADD COLUMN attempt INTEGER;
      ALTER TABLE jobs ADD COLUMN deadline_at INTEGER;
      ALTER TABLE jobs ADD COLUMN failure_class TEXT;
      ALTER TABLE jobs ADD COLUMN correlation_id TEXT;
      ALTER TABLE jobs ADD COLUMN device_id TEXT;
      ALTER TABLE jobs ADD COLUMN file_path TEXT;
      UPDATE jobs
      SET status = json_extract(payload, '$.status'),
          bundle_id = json_extract(payload, '$.bundleId'),
          external_version_id = json_extract(payload, '$.externalVersionId'),
          testflight_build_id = json_extract(payload, '$.testflight.build.id'),
          project_id = COALESCE(json_extract(payload, '$.projectId'), 'default'),
          source = json_extract(payload, '$.source'),
          priority = COALESCE(json_extract(payload, '$.priority'), 0),
          created_at = COALESCE(json_extract(payload, '$.createdAt'), updated_at),
          started_at = json_extract(payload, '$.startedAt'),
          finished_at = json_extract(payload, '$.finishedAt'),
          attempt = json_extract(payload, '$.attempt'),
          deadline_at = json_extract(payload, '$.deadlineAt'),
          failure_class = json_extract(payload, '$.failureClass'),
          correlation_id = json_extract(payload, '$.correlationId'),
          device_id = json_extract(payload, '$.deviceId'),
          file_path = json_extract(payload, '$.filePath')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS jobs_active_exact_build ON jobs(project_id, bundle_id, external_version_id, testflight_build_id, status);
      CREATE INDEX IF NOT EXISTS jobs_completed_exact_build ON jobs(project_id, bundle_id, external_version_id, testflight_build_id, status, file_path);
    `,
  },
  {
    version: 8,
    sql: `
      ALTER TABLE artifacts ADD COLUMN artifact_key TEXT;
      ALTER TABLE artifacts ADD COLUMN bundle_id TEXT;
      ALTER TABLE artifacts ADD COLUMN channel TEXT;
      ALTER TABLE artifacts ADD COLUMN external_version_id TEXT;
      ALTER TABLE artifacts ADD COLUMN testflight_build_id INTEGER;
      ALTER TABLE artifacts ADD COLUMN version_label TEXT;
      ALTER TABLE artifacts ADD COLUMN build_number TEXT;
      ALTER TABLE artifacts ADD COLUMN file_path TEXT;
      ALTER TABLE artifacts ADD COLUMN file_size_bytes INTEGER;
      ALTER TABLE artifacts ADD COLUMN sha256 TEXT;
      ALTER TABLE artifacts ADD COLUMN created_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN last_accessed_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN access_count INTEGER;
      ALTER TABLE artifacts ADD COLUMN pinned_at INTEGER;
      ALTER TABLE artifacts ADD COLUMN source_job_id TEXT;
      UPDATE artifacts
      SET artifact_key = json_extract(payload, '$.key'),
          bundle_id = json_extract(payload, '$.bundleId'),
          channel = json_extract(payload, '$.channel'),
          external_version_id = json_extract(payload, '$.externalVersionId'),
          testflight_build_id = json_extract(payload, '$.testflightBuildId'),
          version_label = json_extract(payload, '$.versionLabel'),
          build_number = json_extract(payload, '$.buildNumber'),
          file_path = json_extract(payload, '$.filePath'),
          file_size_bytes = json_extract(payload, '$.fileSizeBytes'),
          sha256 = json_extract(payload, '$.sha256'),
          created_at = json_extract(payload, '$.createdAt'),
          last_accessed_at = COALESCE(json_extract(payload, '$.lastAccessedAt'), updated_at),
          access_count = COALESCE(json_extract(payload, '$.accessCount'), 0),
          pinned_at = json_extract(payload, '$.pinnedAt'),
          source_job_id = json_extract(payload, '$.sourceJobId')
      WHERE json_valid(payload) = 1;
      CREATE INDEX IF NOT EXISTS artifacts_key_index ON artifacts(artifact_key);
      CREATE INDEX IF NOT EXISTS artifacts_source_job_index ON artifacts(source_job_id);
      CREATE INDEX IF NOT EXISTS artifacts_bundle_channel_recent ON artifacts(bundle_id, channel, created_at DESC);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS artifact_projects (
        artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        PRIMARY KEY (artifact_id, project_id)
      );
      INSERT OR IGNORE INTO artifact_projects (artifact_id, project_id)
      SELECT artifacts.id, project_link.value
      FROM artifacts,
           json_each(CASE WHEN json_valid(artifacts.payload) = 1 THEN artifacts.payload ELSE '{}' END, '$.projectIds') AS project_link
      WHERE project_link.type = 'text';
      CREATE INDEX IF NOT EXISTS artifact_projects_by_project ON artifact_projects(project_id, artifact_id);
    `,
  },
  {
    version: 10,
    sql: `
      ALTER TABLE device_history ADD COLUMN device_id TEXT;
      ALTER TABLE device_history ADD COLUMN history_kind TEXT;
      ALTER TABLE device_history ADD COLUMN occurred_at INTEGER;
      ALTER TABLE device_history ADD COLUMN bundle_id TEXT;
      CREATE INDEX IF NOT EXISTS device_history_by_device_time ON device_history(device_id, occurred_at DESC, id DESC);
      INSERT OR IGNORE INTO device_history (id, payload, updated_at, device_id, history_kind, occurred_at, bundle_id)
      SELECT json_extract(activity.value, '$.id'),
             activity.value,
             COALESCE(json_extract(activity.value, '$.ts'), state_snapshots.updated_at),
             json_extract(activity.value, '$.deviceId'),
             json_extract(activity.value, '$.kind'),
             json_extract(activity.value, '$.ts'),
             json_extract(activity.value, '$.bundleId')
      FROM state_snapshots,
           json_each(CASE WHEN json_valid(state_snapshots.payload) = 1 THEN state_snapshots.payload ELSE '{}' END, '$.deviceActivity') AS activity
      WHERE json_type(activity.value, '$.id') = 'text';
    `,
  },
] as const;

const domainTables = [
  'users',
  'roles',
  'projects',
  'sessions',
  'api_keys',
  'devices',
  'device_health',
  'device_history',
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

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] as string : null;
}

function numberField(record: Record<string, unknown>, key: string): number | null {
  return typeof record[key] === 'number' && Number.isFinite(record[key]) ? record[key] as number : null;
}

function jobIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const job = asRecord(payload);
  const testflight = asRecord(job.testflight);
  const build = asRecord(testflight.build);
  return [
    stringField(job, 'status'),
    stringField(job, 'bundleId'),
    stringField(job, 'externalVersionId'),
    numberField(build, 'id'),
    stringField(job, 'projectId') ?? 'default',
    stringField(job, 'source'),
    numberField(job, 'priority') ?? 0,
    numberField(job, 'createdAt') ?? updatedAt,
    numberField(job, 'startedAt'),
    numberField(job, 'finishedAt'),
    numberField(job, 'attempt'),
    numberField(job, 'deadlineAt'),
    stringField(job, 'failureClass'),
    stringField(job, 'correlationId'),
    stringField(job, 'deviceId'),
    stringField(job, 'filePath'),
  ];
}

function artifactIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const artifact = asRecord(payload);
  return [
    stringField(artifact, 'key'),
    stringField(artifact, 'bundleId'),
    stringField(artifact, 'channel'),
    stringField(artifact, 'externalVersionId'),
    numberField(artifact, 'testflightBuildId'),
    stringField(artifact, 'versionLabel'),
    stringField(artifact, 'buildNumber'),
    stringField(artifact, 'filePath'),
    numberField(artifact, 'fileSizeBytes'),
    stringField(artifact, 'sha256'),
    numberField(artifact, 'createdAt') ?? updatedAt,
    numberField(artifact, 'lastAccessedAt') ?? updatedAt,
    numberField(artifact, 'accessCount') ?? 0,
    numberField(artifact, 'pinnedAt'),
    stringField(artifact, 'sourceJobId'),
  ];
}

function deviceHistoryIndexValues(payload: unknown, updatedAt: number): Array<string | number | null> {
  const entry = asRecord(payload);
  return [
    stringField(entry, 'deviceId'),
    stringField(entry, 'kind'),
    numberField(entry, 'ts') ?? updatedAt,
    stringField(entry, 'bundleId'),
  ];
}

function replaceCollectionRows(database: Database, replacement: StateCollectionReplacement): void {
  database.exec(`DELETE FROM ${replacement.table};`);
  if (replacement.table === 'jobs') {
    const statement = database.query(`
      INSERT INTO jobs (
        id, payload, updated_at, status, bundle_id, external_version_id, testflight_build_id,
        project_id, source, priority, created_at, started_at, finished_at, attempt, deadline_at,
        failure_class, correlation_id, device_id, file_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...jobIndexValues(row.payload, updatedAt));
    }
    return;
  }
  if (replacement.table === 'artifacts') {
    const statement = database.query(`
      INSERT INTO artifacts (
        id, payload, updated_at, artifact_key, bundle_id, channel, external_version_id, testflight_build_id,
        version_label, build_number, file_path, file_size_bytes, sha256, created_at, last_accessed_at,
        access_count, pinned_at, source_job_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `);
    const projectLinkStatement = database.query('INSERT OR IGNORE INTO artifact_projects (artifact_id, project_id) VALUES (?, ?);');
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...artifactIndexValues(row.payload, updatedAt));
      const projectIds = asRecord(row.payload).projectIds;
      if (Array.isArray(projectIds)) {
        for (const projectId of projectIds) {
          if (typeof projectId === 'string') projectLinkStatement.run(row.id, projectId);
        }
      }
    }
    return;
  }
  if (replacement.table === 'device_history') {
    const statement = database.query(`
      INSERT INTO device_history (id, payload, updated_at, device_id, history_kind, occurred_at, bundle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?);
    `);
    for (const row of replacement.rows) {
      const updatedAt = row.updatedAt ?? Date.now();
      statement.run(row.id, json(row.payload), updatedAt, ...deviceHistoryIndexValues(row.payload, updatedAt));
    }
    return;
  }
  const statement = database.query(`INSERT INTO ${replacement.table} (id, payload, updated_at) VALUES (?, ?, ?);`);
  for (const row of replacement.rows) statement.run(row.id, json(row.payload), row.updatedAt ?? Date.now());
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, content, { mode: 0o600 });
    const descriptor = openSync(temporaryPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function writeStateMirror(filePath: string, value: unknown): void {
  atomicWriteJson(filePath, value);
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
    projects: arrayRows(value.projects, 'project'),
    sessions: arrayRows(value.activeSessions, 'session'),
    api_keys: arrayRows(value.apiKeys, 'api-key'),
    devices: arrayRows(value.devices, 'device'),
    device_health: healthRows,
    device_history: arrayRows(value.deviceActivity, 'device-activity'),
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

  writeState(state: unknown, legacyMirrorPath?: string, additionalCollections: readonly StateCollectionReplacement[] = []): void {
    const updatedTables = new Set<string>();
    for (const replacement of additionalCollections) {
      assertCollectionTable(replacement.table);
      if (updatedTables.has(replacement.table)) throw new Error(`duplicate SQLite collection update: ${replacement.table}`);
      updatedTables.add(replacement.table);
    }
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
        replaceCollectionRows(this.db, { table, rows: rows[table] });
      }
      for (const replacement of additionalCollections) {
        replaceCollectionRows(this.db, replacement);
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
      replaceCollectionRows(database, replacement);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export function importLegacyArtifactIndexOnce(database: Database, artifacts: Array<{ id: string; payload: unknown; updatedAt?: number }>): boolean {
  const metadataKey = 'legacy_artifact_index_imported';
  database.exec('BEGIN IMMEDIATE;');
  try {
    const imported = database.query('SELECT 1 AS imported FROM metadata WHERE key = ?;').get(metadataKey) as { imported?: number } | null;
    if (imported?.imported === 1) {
      database.exec('COMMIT;');
      return false;
    }
    replaceCollectionRows(database, { table: 'artifacts', rows: artifacts });
    database.query('INSERT INTO metadata (key, value) VALUES (?, ?);').run(metadataKey, String(Date.now()));
    database.exec('COMMIT;');
    return true;
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
