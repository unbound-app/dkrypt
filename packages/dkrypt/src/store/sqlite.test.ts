import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { openStateCollectionDatabase, openStateDatabase, readStateCollection, replaceStateCollections } from '#store/sqlite.js';

test('SQLite state snapshots survive restart and retain independently owned collections', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    const state = { version: 16, devices: [{ id: 'device-1', updatedAt: 10 }], projects: [{ id: 'project-1', name: 'Default workspace', memberIds: [], isDefault: true, createdBy: 'system', createdAt: 10, updatedAt: 10 }], settings: { maintenanceMode: false } };
    database.writeState(state);
    database.replaceCollection('jobs', [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 20 }]);
    database.writeState({ ...state, settings: { maintenanceMode: true } });
    expect(database.readState()).toEqual({ ...state, settings: { maintenanceMode: true } });
    expect(database.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    database.close();

    const reopened = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(reopened.integrityStatus()).toBe('ok');
    expect(reopened.schemaVersion).toBe(6);
    expect(reopened.readCollection('jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    expect(reopened.readCollection('scheduler_runs')).toEqual([]);
    expect(reopened.readCollection('projects')).toEqual(state.projects);
    reopened.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite keeps scheduler history separate from job timelines', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-scheduler-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.writeState({
      version: 15,
      schedulerRunHistory: [{ id: 'run-1', ts: 100, appStore: {}, testflight: {} }],
      devices: [],
      settings: {},
    });
    expect(database.readCollection('scheduler_runs')).toHaveLength(1);
    expect(database.readCollection('job_timelines')).toEqual([]);
    database.replaceCollection('job_timelines', [{ id: 'job-1', payload: { jobId: 'job-1', events: [] }, updatedAt: 200 }]);
    expect(database.readCollection('job_timelines')).toEqual([{ jobId: 'job-1', events: [] }]);
    database.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite migrates legacy scheduler rows out of job timelines', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-scheduler-migration-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    database.db.query('DELETE FROM schema_migrations WHERE version = 4').run();
    database.db.query('INSERT OR REPLACE INTO job_timelines (id, payload, updated_at) VALUES (?, ?, ?)').run('run-legacy', JSON.stringify({ id: 'run-legacy', ts: 100, appStore: {}, testflight: {} }), 100);
    database.close();

    const migrated = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    expect(migrated.readCollection('job_timelines')).toEqual([]);
    expect(migrated.readCollection('scheduler_runs')).toEqual([{ id: 'run-legacy', ts: 100, appStore: {}, testflight: {} }]);
    migrated.close();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SQLite collection updates commit together and roll back together on failure', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-sqlite-transaction-'));
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['jobs', 'job_timelines']);
  try {
    replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'queued' }, updatedAt: 10 }] },
      { table: 'job_timelines', rows: [{ id: 'job-1', payload: { jobId: 'job-1', events: [{ at: 10, label: 'queued' }] }, updatedAt: 10 }] },
    ]);

    expect(() => replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'done' }, updatedAt: 20 }] },
      { table: 'job_timelines', rows: [
        { id: 'duplicate', payload: { jobId: 'job-1', events: [] }, updatedAt: 20 },
        { id: 'duplicate', payload: { jobId: 'job-2', events: [] }, updatedAt: 20 },
      ] },
    ])).toThrow();

    expect(readStateCollection(database, 'jobs')).toEqual([{ id: 'job-1', status: 'queued' }]);
    expect(readStateCollection(database, 'job_timelines')).toEqual([{ jobId: 'job-1', events: [{ at: 10, label: 'queued' }] }]);

    replaceStateCollections(database, [
      { table: 'jobs', rows: [{ id: 'job-1', payload: { id: 'job-1', status: 'done' }, updatedAt: 30 }] },
      { table: 'job_timelines', rows: [{ id: 'job-1', payload: { jobId: 'job-1', events: [{ at: 30, label: 'done' }] }, updatedAt: 30 }] },
    ]);

    expect(readStateCollection(database, 'jobs')).toEqual([{ id: 'job-1', status: 'done' }]);
    expect(readStateCollection(database, 'job_timelines')).toEqual([{ jobId: 'job-1', events: [{ at: 30, label: 'done' }] }]);
  } finally {
    database.close();
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
