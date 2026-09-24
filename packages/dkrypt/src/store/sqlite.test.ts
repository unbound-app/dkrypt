import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { openStateDatabase } from '#store/sqlite.js';

test('SQLite state snapshots survive restart and retain independently owned collections', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const state = { version: 15, devices: [{ id: 'device-1', updatedAt: 10 }], settings: { maintenanceMode: false } };
    database.writeState(state);
    database.replaceCollection('jobs', [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 20 }]);
    database.writeState({ ...state, settings: { maintenanceMode: true } });
    expect(database.readState()).toEqual({ ...state, settings: { maintenanceMode: true } });
    expect(database.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    database.close();

    const reopened = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(reopened.integrityStatus()).toBe('ok');
    expect(reopened.schemaVersion).toBe(3);
    expect(reopened.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    reopened.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite backup is atomic and can be reopened with its checksum intact', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-backup-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 15, devices: [], settings: {} });
    const backupPath = path.join(stateDir, 'backups', 'state.sqlite');
    await mkdir(path.dirname(backupPath), { recursive: true });
    database.backupTo(backupPath);
    database.close();
    const backup = openStateDatabase({ stateDir: path.dirname(backupPath), filename: path.basename(backupPath) });
    expect(backup.integrityStatus()).toBe('ok');
    expect(backup.readState()).toEqual({ version: 15, devices: [], settings: {} });
    backup.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite rejects a tampered state snapshot instead of returning empty state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-corrupt-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({ version: 15, devices: [], settings: {} });
    database.db.query("UPDATE state_snapshots SET payload = '{\"version\":0}' WHERE id = 1").run();
    expect(() => database.readState()).toThrow('checksum mismatch');
    database.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
