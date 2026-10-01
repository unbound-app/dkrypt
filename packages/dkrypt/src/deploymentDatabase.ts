import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { verifyDatabaseForMigration } from '#store/sqlite.js';

interface DeploymentRollbackManifest {
  deploymentId: string;
  databaseFile: string;
  databasePresent: boolean;
  schemaVersion?: number;
  stateSnapshotChecksum?: string;
  backupFile?: string;
}

export interface DeploymentRollbackPreparation {
  deploymentId: string;
  databasePresent: boolean;
  schemaVersion?: number;
}

export interface DeploymentRollbackResult {
  databaseRestored: boolean;
  candidateDatabasePreserved: boolean;
  candidateRecoveryPath?: string;
}

function safeDeploymentId(deploymentId: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(deploymentId)) throw new Error('deployment ID contains unsupported characters');
  return deploymentId;
}

function safeDatabaseFile(databaseFile: string): string {
  if (!databaseFile || databaseFile === '.' || databaseFile === '..' || path.basename(databaseFile) !== databaseFile || databaseFile.startsWith('.')) throw new Error('deployment database filename must be a plain filename');
  return databaseFile;
}

function rollbackDirectory(stateDir: string): string {
  return path.join(stateDir, 'deployment-rollbacks');
}

function manifestPath(stateDir: string, deploymentId: string): string {
  return path.join(rollbackDirectory(stateDir), `rollback-${safeDeploymentId(deploymentId)}.json`);
}

function backupPath(stateDir: string, deploymentId: string): string {
  return path.join(rollbackDirectory(stateDir), `rollback-${safeDeploymentId(deploymentId)}.sqlite`);
}

function recoveryPath(stateDir: string, deploymentId: string): string {
  return path.join(rollbackDirectory(stateDir), `failed-${safeDeploymentId(deploymentId)}.sqlite`);
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function atomicWrite(filePath: string, value: string): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, 'wx', 0o600);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  closeSync(descriptor);
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
  syncDirectory(path.dirname(filePath));
}

function writeManifest(stateDir: string, manifest: DeploymentRollbackManifest): void {
  atomicWrite(manifestPath(stateDir, manifest.deploymentId), JSON.stringify(manifest));
}

function createDatabaseSnapshot(sourcePath: string, destinationPath: string): ReturnType<typeof verifyDatabaseForMigration> {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  rmSync(temporaryPath, { force: true });
  try {
    const source = new Database(sourcePath, { create: false, readonly: true, strict: true });
    try {
      source.exec('PRAGMA busy_timeout = 10000;');
      source.query('VACUUM INTO ?').run(temporaryPath);
    } finally {
      source.close();
    }
    const verification = verifyDatabaseForMigration(temporaryPath);
    const descriptor = openSync(temporaryPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, destinationPath);
    syncDirectory(path.dirname(destinationPath));
    return verification;
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function readManifest(stateDir: string, deploymentId: string): DeploymentRollbackManifest {
  const filePath = manifestPath(stateDir, deploymentId);
  const value = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<DeploymentRollbackManifest>;
  if (
    value.deploymentId !== deploymentId
    || typeof value.databaseFile !== 'string'
    || typeof value.databasePresent !== 'boolean'
  ) throw new Error('deployment rollback manifest is malformed');
  safeDatabaseFile(value.databaseFile);
  if (value.databasePresent && (typeof value.schemaVersion !== 'number' || typeof value.stateSnapshotChecksum !== 'string' || typeof value.backupFile !== 'string')) {
    throw new Error('deployment rollback manifest is missing database verification data');
  }
  if (value.backupFile !== undefined && value.backupFile !== `rollback-${deploymentId}.sqlite`) throw new Error('deployment rollback manifest contains an invalid backup filename');
  if (value.databasePresent && (value.backupFile !== `rollback-${deploymentId}.sqlite` || !Number.isInteger(value.schemaVersion) || !/^[a-f0-9]{64}$/.test(value.stateSnapshotChecksum!))) {
    throw new Error('deployment rollback manifest contains invalid database verification data');
  }
  return value as DeploymentRollbackManifest;
}

function clearRollbackArtifacts(stateDir: string, manifest: DeploymentRollbackManifest): void {
  rmSync(manifestPath(stateDir, manifest.deploymentId), { force: true });
  if (manifest.backupFile) rmSync(path.join(rollbackDirectory(stateDir), manifest.backupFile), { force: true });
  syncDirectory(rollbackDirectory(stateDir));
}

function sidecarPaths(databasePath: string): string[] {
  return [`${databasePath}-wal`, `${databasePath}-shm`, `${databasePath}-journal`];
}

function restoreCandidateFiles(databasePath: string, candidatePath: string): void {
  const candidateFiles = [candidatePath, `${candidatePath}-wal`, `${candidatePath}-journal`];
  const databaseFiles = [databasePath, `${databasePath}-wal`, `${databasePath}-journal`];
  for (const [index, candidateFile] of candidateFiles.entries()) {
    if (!existsSync(candidateFile)) continue;
    const databaseFile = databaseFiles[index]!;
    copyFileSync(candidateFile, databaseFile);
  }
}

function preserveCandidateDatabase(databasePath: string, candidatePath: string): boolean {
  if ([candidatePath, ...sidecarPaths(candidatePath)].some(existsSync)) throw new Error('failed deployment recovery database already exists');
  const sourceTemporaryPath = `${databasePath}.preserve-${process.pid}.tmp`;
  const databaseFiles = [databasePath, ...sidecarPaths(databasePath)];
  const presentFiles = databaseFiles.filter(existsSync);
  if (!existsSync(databasePath)) {
    for (const [index, source] of databaseFiles.entries()) {
      if (existsSync(source)) copyFileSync(source, index === 0 ? candidatePath : `${candidatePath}${source.slice(databasePath.length)}`);
    }
    for (const source of presentFiles) rmSync(source, { force: true });
    if (presentFiles.length > 0) syncDirectory(path.dirname(databasePath));
    return false;
  }
  let preservedBySnapshot = false;
  try {
    createDatabaseSnapshot(databasePath, candidatePath);
    preservedBySnapshot = true;
  } catch {
    if (existsSync(candidatePath)) throw new Error('failed deployment recovery database already exists');
    copyFileSync(databasePath, sourceTemporaryPath);
    const descriptor = openSync(sourceTemporaryPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(sourceTemporaryPath, 0o600);
    renameSync(sourceTemporaryPath, candidatePath);
    for (const suffix of ['-wal', '-journal']) {
      const sourceSidecar = `${databasePath}${suffix}`;
      if (existsSync(sourceSidecar)) copyFileSync(sourceSidecar, `${candidatePath}${suffix}`);
    }
    syncDirectory(path.dirname(candidatePath));
  }
  for (const source of presentFiles) rmSync(source, { force: true });
  syncDirectory(path.dirname(databasePath));
  return preservedBySnapshot || existsSync(candidatePath);
}

function copyVerifiedSnapshot(sourcePath: string, destinationPath: string, expected: Pick<DeploymentRollbackManifest, 'schemaVersion' | 'stateSnapshotChecksum'>): void {
  const temporaryPath = `${destinationPath}.${process.pid}.tmp`;
  rmSync(temporaryPath, { force: true });
  try {
    copyFileSync(sourcePath, temporaryPath);
    const verification = verifyDatabaseForMigration(temporaryPath);
    if (verification.schemaVersion !== expected.schemaVersion || verification.stateSnapshotChecksum !== expected.stateSnapshotChecksum) {
      throw new Error('deployment rollback snapshot verification failed');
    }
    const descriptor = openSync(temporaryPath, 'r');
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, destinationPath);
    syncDirectory(path.dirname(destinationPath));
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function prepareDeploymentRollback(stateDir: string, deploymentId: string, databaseFile = 'dkrypt.sqlite'): DeploymentRollbackPreparation {
  const id = safeDeploymentId(deploymentId);
  const filename = safeDatabaseFile(databaseFile);
  const directory = rollbackDirectory(stateDir);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const manifest = manifestPath(stateDir, id);
  if (existsSync(manifest)) throw new Error(`deployment rollback is already prepared: ${id}`);
  const databasePath = path.join(stateDir, filename);
  if (!existsSync(databasePath)) {
    const prepared = { deploymentId: id, databaseFile: filename, databasePresent: false } satisfies DeploymentRollbackManifest;
    writeManifest(stateDir, prepared);
    return prepared;
  }
  const sourceVerification = verifyDatabaseForMigration(databasePath);
  const snapshotPath = backupPath(stateDir, id);
  const snapshotVerification = createDatabaseSnapshot(databasePath, snapshotPath);
  if (snapshotVerification.schemaVersion !== sourceVerification.schemaVersion || snapshotVerification.stateSnapshotChecksum !== sourceVerification.stateSnapshotChecksum) {
    rmSync(snapshotPath, { force: true });
    throw new Error('pre-deployment database snapshot does not match the live state');
  }
  const prepared: DeploymentRollbackManifest = {
    deploymentId: id,
    databaseFile: filename,
    databasePresent: true,
    schemaVersion: sourceVerification.schemaVersion,
    stateSnapshotChecksum: sourceVerification.stateSnapshotChecksum,
    backupFile: path.basename(snapshotPath),
  };
  writeManifest(stateDir, prepared);
  return prepared;
}

export function restoreDeploymentRollback(stateDir: string, deploymentId: string): DeploymentRollbackResult {
  const manifest = readManifest(stateDir, safeDeploymentId(deploymentId));
  const databasePath = path.join(stateDir, manifest.databaseFile);
  const candidatePath = recoveryPath(stateDir, manifest.deploymentId);
  let candidateDatabasePreserved = false;
  try {
    if (manifest.databasePresent) {
      const snapshotPath = path.join(rollbackDirectory(stateDir), manifest.backupFile!);
      const snapshotVerification = verifyDatabaseForMigration(snapshotPath);
      if (snapshotVerification.schemaVersion !== manifest.schemaVersion || snapshotVerification.stateSnapshotChecksum !== manifest.stateSnapshotChecksum) {
        throw new Error('pre-deployment rollback database failed integrity verification');
      }
      const currentMatchesSnapshot = existsSync(databasePath)
        && (() => {
          try {
            const currentVerification = verifyDatabaseForMigration(databasePath);
            return currentVerification.schemaVersion === manifest.schemaVersion && currentVerification.stateSnapshotChecksum === manifest.stateSnapshotChecksum;
          } catch {
            return false;
          }
        })();
      if (!currentMatchesSnapshot) {
        candidateDatabasePreserved = preserveCandidateDatabase(databasePath, candidatePath);
        copyVerifiedSnapshot(snapshotPath, databasePath, manifest);
      }
      const restoredVerification = verifyDatabaseForMigration(databasePath);
      if (restoredVerification.schemaVersion !== manifest.schemaVersion || restoredVerification.stateSnapshotChecksum !== manifest.stateSnapshotChecksum) {
        throw new Error('restored deployment database did not match its pre-deployment state');
      }
    } else {
      candidateDatabasePreserved = preserveCandidateDatabase(databasePath, candidatePath);
    }
  } catch (error) {
    if (!existsSync(databasePath) && existsSync(candidatePath)) restoreCandidateFiles(databasePath, candidatePath);
    throw error;
  }
  clearRollbackArtifacts(stateDir, manifest);
  return {
    databaseRestored: manifest.databasePresent,
    candidateDatabasePreserved,
    candidateRecoveryPath: candidateDatabasePreserved ? candidatePath : undefined,
  };
}

export function completeDeploymentRollback(stateDir: string, deploymentId: string): void {
  const manifest = readManifest(stateDir, safeDeploymentId(deploymentId));
  clearRollbackArtifacts(stateDir, manifest);
}

function runCli(): void {
  const stateDir = process.env.STATE_DIR ?? '/data/state';
  const deploymentId = process.argv[3];
  const action = process.argv[2];
  if (!deploymentId) throw new Error('deployment ID is required');
  if (action === 'prepare') {
    console.log(JSON.stringify(prepareDeploymentRollback(stateDir, deploymentId)));
    return;
  }
  if (action === 'restore') {
    console.log(JSON.stringify(restoreDeploymentRollback(stateDir, deploymentId)));
    return;
  }
  if (action === 'complete') {
    completeDeploymentRollback(stateDir, deploymentId);
    return;
  }
  throw new Error('deployment database action must be prepare, restore, or complete');
}

if (import.meta.main) {
  try {
    runCli();
  } catch (error) {
    console.error(`deployment database operation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
