import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createDeviceHistoryRepository } from '#store/deviceHistoryRepository.js';
import { openStateDatabase } from '#store/sqlite.js';

test('device history repository returns only the selected device activity in newest-first order', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-history-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createDeviceHistoryRepository(database.db);
  const older = { id: 'activity-older', ts: 100, deviceId: 'device-a', kind: 'bridge' as const, message: 'older' };
  const newer = { id: 'activity-newer', ts: 200, deviceId: 'device-a', kind: 'job' as const, message: 'newer' };
  const other = { id: 'activity-other', ts: 300, deviceId: 'device-b', kind: 'health' as const, message: 'other' };

  try {
    database.writeState({ version: 18, deviceActivity: [other, newer, older], deviceHealthHistory: {} });
    expect(repository.listByDevice('device-a')).toEqual([newer, older]);
    expect(repository.listByDevice('device-b')).toEqual([other]);
    expect(repository.listByDevice('missing')).toEqual([]);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
