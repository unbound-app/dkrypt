import type { Database } from 'bun:sqlite';
import type { AppWatch } from '#store/state.js';
import { isValidMaintenanceWindow } from '#util/maintenanceWindow.js';
import { isValidTimeZone } from '#util/timezone.js';
import { replaceStateCollections, type StateCollectionReplacement } from '#store/sqlite.js';

interface WatchRow {
  id: string;
  payload: string;
  updated_at: number;
}

export interface WatchRepository {
  listAll(): AppWatch[];
  findById(id: string): AppWatch | undefined;
  collectionReplacement(watches: AppWatch[]): StateCollectionReplacement;
  replaceAll(watches: AppWatch[]): void;
}

export function isAppWatchRecord(value: unknown): value is AppWatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const watch = value as Record<string, unknown>;
  return typeof watch.id === 'string'
    && typeof watch.bundleId === 'string'
    && typeof watch.enabled === 'boolean'
    && (watch.projectId === undefined || (typeof watch.projectId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(watch.projectId)))
    && (watch.timezone === undefined || (typeof watch.timezone === 'string' && isValidTimeZone(watch.timezone)))
    && (watch.maintenanceWindow === undefined || isValidMaintenanceWindow(watch.maintenanceWindow))
    && (watch.missedRunPolicy === undefined || watch.missedRunPolicy === 'skip' || watch.missedRunPolicy === 'runOnce')
    && (watch.lastScheduledAt === undefined || (typeof watch.lastScheduledAt === 'number' && Number.isFinite(watch.lastScheduledAt)));
}

function parseWatch(row: WatchRow): AppWatch {
  const value: unknown = JSON.parse(row.payload);
  if (!isAppWatchRecord(value)) throw new Error('persisted watch is malformed');
  if (value.id !== row.id) throw new Error('persisted watch key does not match its record');
  return structuredClone(value);
}

export function createWatchRepository(database: Database): WatchRepository {
  const listAllQuery = database.query('SELECT id, payload, updated_at FROM watches ORDER BY rowid ASC;');
  const findByIdQuery = database.query('SELECT id, payload, updated_at FROM watches WHERE id = ?;');

  function collectionReplacement(watches: AppWatch[]): StateCollectionReplacement {
    return {
      table: 'watches',
      rows: watches.map((watch) => ({ id: watch.id, payload: watch, updatedAt: watch.updatedAt })),
    };
  }

  function parseRow(row: WatchRow | null): AppWatch | undefined {
    return row ? parseWatch(row) : undefined;
  }

  return {
    listAll() {
      return (listAllQuery.all() as WatchRow[]).map(parseWatch);
    },
    findById(id) {
      return parseRow(findByIdQuery.get(id) as WatchRow | null);
    },
    collectionReplacement,
    replaceAll(watches) {
      replaceStateCollections(database, [collectionReplacement(watches)]);
    },
  };
}
