import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackupScheduleRepository } from '#store/backupScheduleRepository.js';
import { openStateDatabase } from '#store/sqlite.js';

test('backup schedule repository reads configuration after an atomic state write and reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-schedule-repository-'));
  const schedule = { enabled: true, cron: '15 4 * * *', retentionCount: 9 };
  const firstDatabase = openStateDatabase({ stateDir });

  try {
    const repository = createBackupScheduleRepository(firstDatabase.db);
    firstDatabase.writeState({ version: 18, backupSchedule: schedule }, undefined, [repository.collectionReplacement(schedule)]);
    expect(repository.get()).toEqual(schedule);
  } finally {
    firstDatabase.close();
  }

  try {
    const reopenedDatabase = openStateDatabase({ stateDir });
    try {
      expect(createBackupScheduleRepository(reopenedDatabase.db).get()).toEqual(schedule);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('backup schedule repository rejects malformed persisted values', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-backup-schedule-invalid-'));
  const database = openStateDatabase({ stateDir });

  try {
    database.db.query('INSERT INTO backup_schedule (id, payload, updated_at) VALUES (?, ?, ?);').run(
      'active',
      JSON.stringify({ enabled: true, cron: '', retentionCount: 0 }),
      0,
    );
    expect(() => createBackupScheduleRepository(database.db).get()).toThrow('persisted backup schedule is malformed');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
