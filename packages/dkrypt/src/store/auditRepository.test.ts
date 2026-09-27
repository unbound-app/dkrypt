import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createAuditRepository } from '#store/auditRepository.js';
import type { AuditLogEntry } from '#store/state.js';
import { openStateDatabase } from '#store/sqlite.js';

test('audit repository returns newest events with a stable timestamp tie break', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-audit-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createAuditRepository(database.db);
  const events: AuditLogEntry[] = [
    { id: 'audit-older', ts: 100, actor: 'root', action: 'settings.update', target: 'older' },
    { id: 'audit-tie-a', ts: 200, actor: 'root', action: 'settings.update', target: 'tie-a' },
    { id: 'audit-newest', ts: 300, actor: 'root', action: 'settings.update', target: 'newest' },
    { id: 'audit-tie-z', ts: 200, actor: 'root', action: 'settings.update', target: 'tie-z' },
  ];

  try {
    database.writeState({ version: 18, auditLog: events });

    expect(repository.listRecent()).toEqual([events[2], events[3], events[1], events[0]]);
    expect(repository.listRecent(2)).toEqual([events[2], events[3]]);
    expect(repository.count()).toBe(4);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('audit repository backfills event fields when migrating an existing database', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-audit-repository-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const event: AuditLogEntry = {
    id: 'legacy-audit-event',
    ts: 300,
    actor: 'root',
    action: 'settings.update',
    target: 'scheduler',
    detail: 'Preserved',
  };

  try {
    existing.writeState({ version: 18, auditLog: [event] });
    existing.db.exec(`
      DROP INDEX audit_events_by_time;
      DELETE FROM schema_migrations WHERE version = 13;
      ALTER TABLE audit_events DROP COLUMN occurred_at;
      ALTER TABLE audit_events DROP COLUMN target;
      ALTER TABLE audit_events DROP COLUMN action;
      ALTER TABLE audit_events DROP COLUMN actor;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(15);
      expect(createAuditRepository(migrated.db).listRecent()).toEqual([event]);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
