import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createNotificationRepository } from '#store/notificationRepository.js';
import type { NotificationRecord } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase } from '#store/sqlite.js';
import { encodeCursor } from '#util/cursor.js';

test('notification repository returns only one user notifications newest first', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-notification-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createNotificationRepository(database.db);
  const older: NotificationRecord = {
    id: 'notification-older',
    userId: 'Member@example.com',
    title: 'Older',
    message: 'First',
    severity: 'info',
    createdAt: 100,
  };
  const newer: NotificationRecord = {
    id: 'notification-newer',
    userId: 'Member@example.com',
    title: 'Newer',
    message: 'Second',
    severity: 'success',
    createdAt: 200,
  };
  const other: NotificationRecord = {
    id: 'notification-other',
    userId: 'other@example.com',
    title: 'Private',
    message: 'Not yours',
    severity: 'warning',
    createdAt: 300,
  };

  try {
    database.writeState({ version: 18, notifications: [older, other, newer] });

    expect(repository.listByUser('member@example.com')).toEqual([newer, older]);
    expect(repository.listByUser('missing@example.com')).toEqual([]);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('notification repository backfills per-user fields when migrating an existing database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-notification-repository-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const notification: NotificationRecord = {
    id: 'legacy-notification',
    userId: 'Member@example.com',
    title: 'Legacy',
    message: 'Preserved',
    severity: 'warning',
    createdAt: 100,
    readAt: 200,
    jobId: 'job-legacy',
  };

  try {
    existing.writeState({ version: 18, notifications: [notification] });
    existing.db.exec(`
      DROP INDEX notifications_by_user_time;
      DROP INDEX notifications_unread_by_user;
      DELETE FROM schema_migrations WHERE version = 12;
      ALTER TABLE notifications DROP COLUMN job_id;
      ALTER TABLE notifications DROP COLUMN severity;
      ALTER TABLE notifications DROP COLUMN read_at;
      ALTER TABLE notifications DROP COLUMN created_at;
      ALTER TABLE notifications DROP COLUMN user_id;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(createNotificationRepository(migrated.db).listByUser('member@example.com')).toEqual([notification]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('notification repository keyset pages preserve order across new arrivals and include account counts', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-notification-repository-pages-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createNotificationRepository(database.db);
  const notifications: NotificationRecord[] = [
    { id: 'notification-z', userId: 'Member@example.com', title: 'Newest', message: 'Read', severity: 'info', createdAt: 200, readAt: 250 },
    { id: 'notification-y', userId: 'Member@example.com', title: 'Newest tie', message: 'Unread', severity: 'info', createdAt: 200 },
    { id: 'notification-b', userId: 'Member@example.com', title: 'Older', message: 'Unread', severity: 'warning', createdAt: 100 },
    { id: 'notification-a', userId: 'Member@example.com', title: 'Oldest tie', message: 'Read', severity: 'success', createdAt: 100, readAt: 150 },
    { id: 'notification-private', userId: 'another@example.com', title: 'Private', message: 'Not yours', severity: 'error', createdAt: 300 },
  ];

  try {
    database.writeState({ version: 18, notifications });

    const firstPage = repository.listPageByUser('member@example.com', { limit: 2 });
    expect(firstPage.notifications.map((notification) => notification.id)).toEqual(['notification-z', 'notification-y']);
    expect(firstPage.total).toBe(4);
    expect(firstPage.unread).toBe(2);
    expect(typeof firstPage.nextCursor).toBe('string');

    database.writeState({
      version: 18,
      notifications: [
        ...notifications,
        { id: 'notification-new', userId: 'member@example.com', title: 'Arrived later', message: 'Unread', severity: 'info', createdAt: 300 },
      ],
    });
    const secondPage = repository.listPageByUser('MEMBER@example.com', { limit: 2, cursor: firstPage.nextCursor });

    expect(secondPage.notifications.map((notification) => notification.id)).toEqual(['notification-b', 'notification-a']);
    expect(secondPage).toMatchObject({ total: 5, unread: 3, nextCursor: undefined });
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('notification repository accepts legacy offset cursors during page migration', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-notification-repository-offset-pages-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createNotificationRepository(database.db);
  const notifications: NotificationRecord[] = ['d', 'c', 'b', 'a'].map((id, index) => ({
    id: `notification-${id}`,
    userId: 'member@example.com',
    title: id,
    message: id,
    severity: 'info',
    createdAt: 400 - index * 100,
  }));

  try {
    database.writeState({ version: 18, notifications });

    const page = repository.listPageByUser('member@example.com', { limit: 2, cursor: encodeCursor(2) });

    expect(page.notifications.map((notification) => notification.id)).toEqual(['notification-b', 'notification-a']);
    expect(page.nextCursor).toBeUndefined();
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
