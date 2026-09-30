import type { Database } from 'bun:sqlite';
import type { BackupHistoryEntry } from '#store/state.js';
import { replaceStateCollections, type StateCollectionReplacement } from '#store/sqlite.js';

interface BackupRow {
  id: string;
  payload: string;
  updated_at: number;
}

export interface BackupRepository {
  listAll(): BackupHistoryEntry[];
  findById(id: string): BackupHistoryEntry | undefined;
  collectionReplacement(entries: BackupHistoryEntry[]): StateCollectionReplacement;
  replaceAll(entries: BackupHistoryEntry[]): void;
}

function isBackupHistoryRecord(value: unknown): value is BackupHistoryEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.createdAt === 'number'
    && Number.isFinite(entry.createdAt)
    && typeof entry.sizeBytes === 'number'
    && Number.isFinite(entry.sizeBytes)
    && entry.sizeBytes >= 0
    && typeof entry.filename === 'string'
    && entry.filename.length > 0
    && (entry.trigger === 'scheduled' || entry.trigger === 'manual')
    && (entry.restoreDrillStatus === 'not_run' || entry.restoreDrillStatus === 'passed' || entry.restoreDrillStatus === 'failed')
    && (entry.databaseFilename === undefined || typeof entry.databaseFilename === 'string')
    && (entry.manifestFilename === undefined || typeof entry.manifestFilename === 'string')
    && (entry.schemaVersion === undefined || (typeof entry.schemaVersion === 'number' && Number.isFinite(entry.schemaVersion)))
    && (entry.integrity === undefined || entry.integrity === 'verified' || entry.integrity === 'failed' || entry.integrity === 'unavailable')
    && (entry.encryptedManifest === undefined || typeof entry.encryptedManifest === 'boolean')
    && (entry.restoreDrillAt === undefined || (typeof entry.restoreDrillAt === 'number' && Number.isFinite(entry.restoreDrillAt)))
    && (entry.restoreDrillChecks === undefined || (Array.isArray(entry.restoreDrillChecks) && entry.restoreDrillChecks.every((check) => {
      if (typeof check !== 'object' || check === null || Array.isArray(check)) return false;
      const record = check as Record<string, unknown>;
      return typeof record.label === 'string' && typeof record.ok === 'boolean' && typeof record.detail === 'string';
    })));
}

function parseBackup(row: BackupRow): BackupHistoryEntry {
  const value: unknown = JSON.parse(row.payload);
  if (!isBackupHistoryRecord(value)) throw new Error('persisted backup is malformed');
  if (value.id !== row.id) throw new Error('persisted backup key does not match its record');
  return structuredClone(value);
}

export function createBackupRepository(database: Database): BackupRepository {
  const listAllQuery = database.query('SELECT id, payload, updated_at FROM backups ORDER BY updated_at DESC, rowid DESC;');
  const findByIdQuery = database.query('SELECT id, payload, updated_at FROM backups WHERE id = ?;');

  function collectionReplacement(entries: BackupHistoryEntry[]): StateCollectionReplacement {
    return {
      table: 'backups',
      rows: entries.map((entry) => ({ id: entry.id, payload: entry, updatedAt: entry.createdAt })),
    };
  }

  return {
    listAll() {
      return (listAllQuery.all() as BackupRow[]).map(parseBackup).sort((left, right) => right.createdAt - left.createdAt);
    },
    findById(id) {
      const row = findByIdQuery.get(id) as BackupRow | null;
      return row ? parseBackup(row) : undefined;
    },
    collectionReplacement,
    replaceAll(entries) {
      replaceStateCollections(database, [collectionReplacement(entries)]);
    },
  };
}
