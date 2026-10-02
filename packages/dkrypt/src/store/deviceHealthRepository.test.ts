import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createDeviceHealthRepository } from '#store/deviceHealthRepository.js';
import { openStateDatabase } from '#store/sqlite.js';

test('device health repository returns checks for one device in newest-first order', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-health-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createDeviceHealthRepository(database.db);
  const older = { ts: 100, reachable: true, batteryPercent: 82 };
  const newer = { ts: 200, reachable: false, batteryPercent: 81, subsystems: { agent: 'offline' as const }, subsystemDetails: { agent: { state: 'offline' as const, lastChangedAt: 175, reason: 'agent request timed out' } } };
  const other = { ts: 300, reachable: true };

  try {
    database.writeState({
      version: 18,
      deviceActivity: [],
      deviceHealthHistory: { 'device-a': [older, newer], 'device-b': [other] },
    });
    expect(repository.listByDevice('device-a')).toEqual([newer, older]);
    expect(repository.listByDevice('device-b')).toEqual([other]);
    expect(repository.listByDevice('missing')).toEqual([]);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
