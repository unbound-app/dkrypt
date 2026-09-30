import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSettingsRepository } from '#store/settingsRepository.js';
import { openStateDatabase } from '#store/sqlite.js';
import type { PersistedSettings } from '#store/state.js';

test('settings repository stores individual typed values and replaces the collection atomically', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-settings-repository-'));
  const firstDatabase = openStateDatabase({ stateDir });
  const firstRepository = createSettingsRepository(firstDatabase.db);
  const initial: PersistedSettings = {
    maintenanceMode: false,
    notifyQuietHoursStart: '22:30',
    jobHistoryRetentionDays: 30,
    billingCheckoutsPaused: true,
  };

  try {
    firstRepository.replaceAll(initial);

    expect(firstRepository.listAll()).toEqual(initial);
    expect(firstRepository.collectionReplacement(initial).rows).toEqual([
      { id: 'setting-maintenanceMode', payload: { key: 'maintenanceMode', value: false }, updatedAt: 0 },
      { id: 'setting-notifyQuietHoursStart', payload: { key: 'notifyQuietHoursStart', value: '22:30' }, updatedAt: 0 },
      { id: 'setting-jobHistoryRetentionDays', payload: { key: 'jobHistoryRetentionDays', value: 30 }, updatedAt: 0 },
      { id: 'setting-billingCheckoutsPaused', payload: { key: 'billingCheckoutsPaused', value: true }, updatedAt: 0 },
    ]);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      const reopenedRepository = createSettingsRepository(reopenedDatabase.db);
      reopenedRepository.replaceAll({ maintenanceMode: true });
      expect(reopenedRepository.listAll()).toEqual({ maintenanceMode: true });
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
