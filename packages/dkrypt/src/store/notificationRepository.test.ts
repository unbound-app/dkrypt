import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createNotificationRepository } from '#store/notificationRepository.js';
import type { NotificationRecord } from '#store/state.js';
import { openStateDatabase } from '#store/sqlite.js';

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
      expect(migrated.schemaVersion).toBe(14);
      expect(createNotificationRepository(migrated.db).listByUser('member@example.com')).toEqual([notification]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
