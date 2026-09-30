import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackupRepository } from '#store/backupRepository.js';
import { openStateDatabase } from '#store/sqlite.js';
import type { BackupHistoryEntry } from '#store/state.js';

function backup(id: string, createdAt: number): BackupHistoryEntry {
  return {
    id,
    createdAt,
    sizeBytes: 2048,
    filename: `snapshot-${id}/backup.json`,
    databaseFilename: `snapshot-${id}/backup.sqlite`,
    manifestFilename: `snapshot-${id}/backup.manifest`,
    trigger: 'manual',
    integrity: 'verified',
    encryptedManifest: true,
    restoreDrillStatus: 'passed',
    restoreDrillAt: createdAt + 10,
    restoreDrillChecks: [{ label: 'SQLite restore', ok: true, detail: 'restored' }],
  };
}

test('backup repository preserves integrity and restore-drill details across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-repository-'));
  const entry = backup('snapshot-a', 100);
  const firstDatabase = openStateDatabase({ stateDir });

  try {
    const repository = createBackupRepository(firstDatabase.db);
    repository.replaceAll([entry]);
    expect(repository.findById(entry.id)).toEqual(entry);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      const repository = createBackupRepository(reopenedDatabase.db);
      expect(repository.listAll()).toEqual([entry]);
      repository.replaceAll([]);
      expect(repository.listAll()).toEqual([]);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('backup repository rejects records whose row key does not match the snapshot id', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-invalid-'));
  const database = openStateDatabase({ stateDir });

  try {
    database.db.query('INSERT INTO backups (id, payload, updated_at) VALUES (?, ?, ?);').run('backup-row', JSON.stringify(backup('backup-payload', 100)), 100);
    expect(() => createBackupRepository(database.db).listAll()).toThrow('persisted backup key does not match its record');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
