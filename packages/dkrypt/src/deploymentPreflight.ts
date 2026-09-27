import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { openStateDatabase, verifyDatabaseForMigration, type StateDatabase } from '#store/sqlite.js';

export type DeploymentPreflightResult =
  | { status: 'no_database' }
  | { status: 'verified'; sourceSchemaVersion: number; candidateSchemaVersion: number; integrity: 'ok'; restoredState: true };

function createDatabaseSnapshot(sourcePath: string, destinationPath: string): void {
  const source = new Database(sourcePath, { create: false, readonly: true, strict: true });
  try {
    source.exec('PRAGMA busy_timeout = 10000;');
    source.query('VACUUM INTO ?').run(destinationPath);
  } finally {
    source.close();
  }
}

function closeIfOpen(database: StateDatabase | undefined): void {
  database?.close();
}

function migrationDryRun(sourcePath: string, workDir: string, filename: string): void {
  const dryRunDir = path.join(workDir, 'dry-run');
  mkdirSync(dryRunDir, { recursive: true });
  const dryRunPath = path.join(dryRunDir, filename);
  try {
    copyFileSync(sourcePath, dryRunPath);
    let database: StateDatabase | undefined;
    try {
      database = openStateDatabase({ stateDir: dryRunDir, filename, migrationDryRun: true });
    } catch (error) {
      const expectedDryRun = error instanceof Error && /^SQLite migration dry run completed; \d+ migration\(s\) were not applied$/.test(error.message);
      if (!expectedDryRun) throw error;
    } finally {
      closeIfOpen(database);
    }
    const verified = verifyDatabaseForMigration(dryRunPath);
    const original = verifyDatabaseForMigration(sourcePath);
    if (verified.schemaVersion !== original.schemaVersion || verified.stateSnapshotChecksum !== original.stateSnapshotChecksum) {
      throw new Error('SQLite migration dry run changed the isolated source snapshot');
    }
  } finally {
    rmSync(dryRunDir, { recursive: true, force: true });
  }
}

function restoreAndMigrate(sourcePath: string, workDir: string, filename: string): { databasePath: string; schemaVersion: number; snapshotChecksum: string; preMigrationBackupPath?: string } {
  const restoreDir = path.join(workDir, 'restore');
  mkdirSync(restoreDir, { recursive: true });
  const restorePath = path.join(restoreDir, filename);
  copyFileSync(sourcePath, restorePath);
  let database: StateDatabase | undefined;
  let state: unknown;
  let schemaVersion = 0;
  try {
    database = openStateDatabase({ stateDir: restoreDir, filename });
    state = database.readState();
    if (state === undefined) throw new Error('Restored SQLite database has no state snapshot');
    database.integrityStatus();
    schemaVersion = database.schemaVersion;
  } finally {
    closeIfOpen(database);
  }
  const verified = verifyDatabaseForMigration(restorePath);
  if (verified.schemaVersion !== schemaVersion) throw new Error('Restored SQLite database schema version changed unexpectedly');
  const backupDirectory = path.join(restoreDir, 'backups');
  const backupName = existsSync(backupDirectory)
    ? readdirSync(backupDirectory).filter((name) => name.startsWith('pre-migration-') && name.endsWith('.sqlite')).sort().at(-1)
    : undefined;
  return {
    databasePath: restorePath,
    schemaVersion,
    snapshotChecksum: verified.stateSnapshotChecksum,
    preMigrationBackupPath: backupName ? path.join(backupDirectory, backupName) : undefined,
  };
}

function verifyPreMigrationBackup(sourceSnapshotPath: string, workDir: string, filename: string, sourceVerification: ReturnType<typeof verifyDatabaseForMigration>, restored: ReturnType<typeof restoreAndMigrate>): void {
  if (sourceVerification.schemaVersion === restored.schemaVersion) return;
  const backupPath = restored.preMigrationBackupPath;
  if (!backupPath) throw new Error('Candidate migrations did not create a pre-migration SQLite backup');
  const backupVerification = verifyDatabaseForMigration(backupPath);
  if (backupVerification.schemaVersion !== sourceVerification.schemaVersion || backupVerification.stateSnapshotChecksum !== sourceVerification.stateSnapshotChecksum) {
    throw new Error('Pre-migration SQLite backup does not match the source database');
  }
  rmSync(sourceSnapshotPath, { force: true });
  const restoreDirectory = path.dirname(restored.databasePath);
  for (const entry of readdirSync(restoreDirectory)) {
    if (entry !== 'backups') rmSync(path.join(restoreDirectory, entry), { recursive: true, force: true });
  }
  const restoredBackup = restoreAndMigrate(backupPath, path.join(workDir, 'backup-restore'), filename);
  if (restoredBackup.schemaVersion !== restored.schemaVersion || restoredBackup.snapshotChecksum !== sourceVerification.stateSnapshotChecksum) {
    throw new Error('Pre-migration SQLite backup restore did not preserve state');
  }
}

export function runDeploymentPreflight(databasePath: string, temporaryDirectory = tmpdir()): DeploymentPreflightResult {
  if (!existsSync(databasePath)) return { status: 'no_database' };
  const workDir = mkdtempSync(path.join(temporaryDirectory, 'dkrypt-deployment-preflight-'));
  try {
    const sourceSnapshotPath = path.join(workDir, 'source.sqlite');
    createDatabaseSnapshot(databasePath, sourceSnapshotPath);
    const sourceVerification = verifyDatabaseForMigration(sourceSnapshotPath);
    migrationDryRun(sourceSnapshotPath, workDir, 'dry-run.sqlite');
    const restored = restoreAndMigrate(sourceSnapshotPath, workDir, 'restored.sqlite');
    if (restored.snapshotChecksum !== sourceVerification.stateSnapshotChecksum) throw new Error('SQLite migration restore did not preserve the state snapshot');
    verifyPreMigrationBackup(sourceSnapshotPath, workDir, 'restored.sqlite', sourceVerification, restored);
    return {
      status: 'verified',
      sourceSchemaVersion: sourceVerification.schemaVersion,
      candidateSchemaVersion: restored.schemaVersion,
      integrity: 'ok',
      restoredState: true,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function runCli(): void {
  const stateDir = process.env.STATE_DIR ?? '/data/state';
  const filename = process.env.STATE_DATABASE_FILE ?? 'dkrypt.sqlite';
  const result = runDeploymentPreflight(path.join(stateDir, filename));
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    console.error(`SQLite deployment preflight failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
