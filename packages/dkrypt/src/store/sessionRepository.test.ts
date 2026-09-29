import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createSessionRepository } from '#store/sessionRepository.js';
import type { ActiveSessionRecord } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase } from '#store/sqlite.js';
import { rewindSessionSearchMigration } from '#store/sqliteTestHelpers.js';

test('session repository lists one account newest last-seen first and finds active records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-session-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createSessionRepository(database.db);
  const older: ActiveSessionRecord = { id: 'session-older', sub: 'member@example.com', createdAt: 100, lastSeenAt: 200 };
  const newer: ActiveSessionRecord = { id: 'session-newer', sub: 'member@example.com', createdAt: 150, lastSeenAt: 300 };
  const privateRecord: ActiveSessionRecord = { id: 'session-private', sub: 'other@example.com', createdAt: 250, lastSeenAt: 400 };
  const tied: ActiveSessionRecord = { id: 'session-tie', sub: 'member@example.com', createdAt: 160, lastSeenAt: 300 };

  try {
    database.writeState({ version: 18, activeSessions: [older, privateRecord, newer, tied] });

    expect(repository.listByUser('MEMBER@example.com')).toEqual([newer, tied, older]);
    expect(repository.listAll()).toEqual([older, privateRecord, newer, tied]);
    expect(repository.findById('session-newer')).toEqual(newer);
    expect(repository.findById('missing-session')).toBeUndefined();
    expect(repository.isActive('session-private')).toBe(true);
    expect(repository.touch('session-newer', 500)).toBe(true);
    expect(repository.findById('session-newer')).toMatchObject({ lastSeenAt: 500 });
    expect(repository.deleteExpiredBefore(250)).toBe(1);
    expect(repository.listAll().map((record) => record.id)).toEqual(['session-private', 'session-newer', 'session-tie']);
    expect(repository.touch('missing-session', 600)).toBe(false);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('session repository creates bounded sessions and revokes only the requested account records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-session-repository-lifecycle-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createSessionRepository(database.db);
  const userId = 'member@example.com';
  const first: ActiveSessionRecord = { id: 'session-first', sub: userId, createdAt: 100, lastSeenAt: 100 };
  const second: ActiveSessionRecord = { id: 'session-second', sub: userId, createdAt: 200, lastSeenAt: 200 };
  const third: ActiveSessionRecord = { id: 'session-third', sub: userId, createdAt: 300, lastSeenAt: 300 };

  try {
    repository.create(first, 2);
    repository.create(second, 2);
    repository.create(third, 2);

    expect(repository.listAll()).toEqual([second, third]);
    expect(repository.revoke(second.id, 'another@example.com')).toBe(false);
    expect(repository.isActive(second.id)).toBe(true);
    expect(repository.revoke(second.id, userId)).toBe(true);
    expect(repository.revokeOthers(userId, third.id)).toBe(0);
    expect(repository.listAll()).toEqual([third]);
    repository.create({ id: 'session-other', sub: 'another@example.com', createdAt: 400, lastSeenAt: 400 }, 2);
    expect(repository.revokeUser(userId)).toBe(1);
    expect(repository.listAll().map((record) => record.id)).toEqual(['session-other']);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('session repository migration retains active sessions from the previous schema', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-session-repository-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const session: ActiveSessionRecord = {
    id: 'session-before-migration',
    sub: 'member@example.com',
    createdAt: 100,
    lastSeenAt: 200,
    userAgent: 'Browser',
    ip: '198.51.100.5',
  };

  try {
    existing.writeState({ version: 18, activeSessions: [session] });
    rewindSessionSearchMigration(existing.db);
    existing.db.exec(`
      DELETE FROM schema_migrations WHERE version = 18;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(migrated.readState()).toMatchObject({ activeSessions: [session] });
      expect(createSessionRepository(migrated.db).listByUser('member@example.com')).toEqual([session]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
