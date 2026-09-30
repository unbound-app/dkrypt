import type { Database } from 'bun:sqlite';
import type { BackupScheduleSettings } from '#store/state.js';
import type { StateCollectionReplacement } from '#store/sqlite.js';

interface BackupScheduleRow {
  id: string;
  payload: string;
}

export interface BackupScheduleRepository {
  get(): BackupScheduleSettings | undefined;
  collectionReplacement(schedule: BackupScheduleSettings): StateCollectionReplacement;
}

function isBackupSchedule(value: unknown): value is BackupScheduleSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const schedule = value as Record<string, unknown>;
  return Object.keys(schedule).length === 3
    && typeof schedule.enabled === 'boolean'
    && typeof schedule.cron === 'string'
    && schedule.cron.trim().length > 0
    && schedule.cron.length <= 100
    && typeof schedule.retentionCount === 'number'
    && Number.isInteger(schedule.retentionCount)
    && schedule.retentionCount >= 1
    && schedule.retentionCount <= 90;
}

function parseSchedule(row: BackupScheduleRow): BackupScheduleSettings {
  const value: unknown = JSON.parse(row.payload);
  if (row.id !== 'active' || !isBackupSchedule(value)) throw new Error('persisted backup schedule is malformed');
  return structuredClone(value);
}

export function createBackupScheduleRepository(database: Database): BackupScheduleRepository {
  const getQuery = database.query('SELECT id, payload FROM backup_schedule WHERE id = ?;');

  function collectionReplacement(schedule: BackupScheduleSettings): StateCollectionReplacement {
    if (!isBackupSchedule(schedule)) throw new Error('backup schedule is malformed');
    return { table: 'backup_schedule', rows: [{ id: 'active', payload: schedule, updatedAt: 0 }] };
  }

  return {
    get() {
      const row = getQuery.get('active') as BackupScheduleRow | null;
      return row ? parseSchedule(row) : undefined;
    },
    collectionReplacement,
  };
}
