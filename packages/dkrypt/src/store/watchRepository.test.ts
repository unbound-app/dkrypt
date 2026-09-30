import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWatchRepository } from '#store/watchRepository.js';
import { openStateDatabase } from '#store/sqlite.js';
import type { AppWatch } from '#store/state.js';

function watch(id: string): AppWatch {
  return {
    id,
    projectId: 'default',
    bundleId: 'com.example.app',
    repo: 'owner/app',
    ghWorkflowFile: 'update.yml',
    dispatchTargets: [{ repo: 'owner/app', ghWorkflowFile: 'update.yml', mode: 'workflow_dispatch', ref: 'main', inputs: { source: 'app-store' } }],
    pollCron: '0 */6 * * *',
    timezone: 'Europe/Berlin',
    maintenanceWindow: { start: '23:00', end: '06:00' },
    missedRunPolicy: 'runOnce',
    lastScheduledAt: 200,
    enabled: true,
    testFlightPolicy: 'latestNonExpired',
    createdAt: 100,
    updatedAt: 200,
  };
}

test('watch repository preserves complete schedule configuration across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-watch-repository-'));
  const firstDatabase = openStateDatabase({ stateDir });
  const firstRepository = createWatchRepository(firstDatabase.db);
  const entry = watch('watch-a');

  try {
    firstRepository.replaceAll([entry]);
    expect(firstRepository.listAll()).toEqual([entry]);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      const reopenedRepository = createWatchRepository(reopenedDatabase.db);
      expect(reopenedRepository.findById(entry.id)).toEqual(entry);
      reopenedRepository.replaceAll([]);
      expect(reopenedRepository.listAll()).toEqual([]);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('watch repository rejects malformed records instead of hiding them', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-watch-invalid-'));
  const database = openStateDatabase({ stateDir });

  try {
    database.db.query('INSERT INTO watches (id, payload, updated_at) VALUES (?, ?, ?);').run('watch-bad', JSON.stringify({ id: 'different-id' }), 100);
    expect(() => createWatchRepository(database.db).listAll()).toThrow('persisted watch is malformed');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
