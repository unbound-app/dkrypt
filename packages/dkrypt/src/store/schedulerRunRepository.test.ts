import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSchedulerRunRepository } from '#store/schedulerRunRepository.js';
import { openStateDatabase } from '#store/sqlite.js';
import type { SchedulerRunEntry } from '#store/state.js';

function schedulerRun(id: string): SchedulerRunEntry {
  return {
    id,
    ts: 200,
    watchId: 'watch-a',
    bundleId: 'com.example.app',
    appStore: { ok: true, triggered: true, reason: 'dispatched', runUrl: 'https://github.com/owner/app/actions/runs/1', runStatus: 'dispatched', versionLabel: '1.2.3' },
    testflight: { ok: false, triggered: false, reason: 'no eligible build', dispatchTargetKeys: ['owner/app:update.yml'] },
  };
}

test('scheduler run repository retains both automation outcomes across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-run-repository-'));
  const firstDatabase = openStateDatabase({ stateDir });
  const firstRepository = createSchedulerRunRepository(firstDatabase.db);
  const entry = schedulerRun('run-a');

  try {
    firstRepository.replaceAll([entry]);
    expect(firstRepository.listAll()).toEqual([entry]);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      const reopenedRepository = createSchedulerRunRepository(reopenedDatabase.db);
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

test('scheduler run repository rejects malformed records instead of hiding them', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-scheduler-run-invalid-'));
  const database = openStateDatabase({ stateDir });

  try {
    database.db.query('INSERT INTO scheduler_runs (id, payload, updated_at) VALUES (?, ?, ?);').run('run-bad', JSON.stringify({ id: 'different-id', ts: 1, appStore: {}, testflight: {} }), 100);
    expect(() => createSchedulerRunRepository(database.db).listAll()).toThrow('persisted scheduler run key does not match its record');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
