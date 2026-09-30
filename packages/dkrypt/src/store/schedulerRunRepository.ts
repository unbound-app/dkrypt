import type { Database } from 'bun:sqlite';
import type { SchedulerRunEntry } from '#store/state.js';
import { replaceStateCollections, type StateCollectionReplacement } from '#store/sqlite.js';

interface SchedulerRunRow {
  id: string;
  payload: string;
  updated_at: number;
}

export interface SchedulerRunRepository {
  listAll(): SchedulerRunEntry[];
  findById(id: string): SchedulerRunEntry | undefined;
  collectionReplacement(entries: SchedulerRunEntry[]): StateCollectionReplacement;
  replaceAll(entries: SchedulerRunEntry[]): void;
}

function isSchedulerRunRecord(value: unknown): value is SchedulerRunEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === 'string'
    && typeof entry.ts === 'number'
    && Number.isFinite(entry.ts)
    && typeof entry.appStore === 'object'
    && entry.appStore !== null
    && !Array.isArray(entry.appStore)
    && typeof entry.testflight === 'object'
    && entry.testflight !== null
    && !Array.isArray(entry.testflight);
}

function parseSchedulerRun(row: SchedulerRunRow): SchedulerRunEntry {
  const value: unknown = JSON.parse(row.payload);
  if (!isSchedulerRunRecord(value)) throw new Error('persisted scheduler run is malformed');
  if (value.id !== row.id) throw new Error('persisted scheduler run key does not match its record');
  return structuredClone(value);
}

export function createSchedulerRunRepository(database: Database): SchedulerRunRepository {
  const listAllQuery = database.query('SELECT id, payload, updated_at FROM scheduler_runs ORDER BY rowid ASC;');
  const findByIdQuery = database.query('SELECT id, payload, updated_at FROM scheduler_runs WHERE id = ?;');

  function collectionReplacement(entries: SchedulerRunEntry[]): StateCollectionReplacement {
    return {
      table: 'scheduler_runs',
      rows: entries.map((entry) => ({ id: entry.id, payload: entry, updatedAt: entry.ts })),
    };
  }

  return {
    listAll() {
      return (listAllQuery.all() as SchedulerRunRow[]).map(parseSchedulerRun);
    },
    findById(id) {
      const row = findByIdQuery.get(id) as SchedulerRunRow | null;
      return row ? parseSchedulerRun(row) : undefined;
    },
    collectionReplacement,
    replaceAll(entries) {
      replaceStateCollections(database, [collectionReplacement(entries)]);
    },
  };
}
