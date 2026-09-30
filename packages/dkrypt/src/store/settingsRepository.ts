import type { Database } from 'bun:sqlite';
import type { PersistedSettings } from '#store/state.js';
import { replaceStateCollections, type StateCollectionReplacement } from '#store/sqlite.js';

interface SettingRow {
  id: string;
  payload: string;
}

interface SettingPayload {
  key: string;
  value: unknown;
}

export interface SettingsRepository {
  listAll(): PersistedSettings;
  collectionReplacement(settings: PersistedSettings): StateCollectionReplacement;
  replaceAll(settings: PersistedSettings): void;
}

function parseSetting(row: SettingRow): SettingPayload {
  const payload: unknown = JSON.parse(row.payload);
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new Error('persisted setting is malformed');
  const setting = payload as Record<string, unknown>;
  if (typeof setting.key !== 'string' || !Object.hasOwn(setting, 'value') || row.id !== `setting-${setting.key}`) {
    throw new Error('persisted setting key does not match its record');
  }
  return { key: setting.key, value: setting.value };
}

export function createSettingsRepository(database: Database): SettingsRepository {
  const listAllQuery = database.query('SELECT id, payload FROM settings ORDER BY rowid ASC;');

  function collectionReplacement(settings: PersistedSettings): StateCollectionReplacement {
    return {
      table: 'settings',
      rows: Object.entries(settings).filter(([, value]) => value !== undefined).map(([key, value]) => ({
        id: `setting-${key}`,
        payload: { key, value },
        updatedAt: 0,
      })),
    };
  }

  return {
    listAll() {
      const entries = (listAllQuery.all() as SettingRow[]).map(parseSetting).map(({ key, value }) => [key, value]);
      return Object.fromEntries(entries) as PersistedSettings;
    },
    collectionReplacement,
    replaceAll(settings) {
      replaceStateCollections(database, [collectionReplacement(settings)]);
    },
  };
}
