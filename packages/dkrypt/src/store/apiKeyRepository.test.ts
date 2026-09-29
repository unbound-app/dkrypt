import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createApiKeyRepository } from '#store/apiKeyRepository.js';
import type { ApiKeyRecord } from '#store/state.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase } from '#store/sqlite.js';

test('API keys remain verifiable across restart within their current and grace-period expiry windows', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-repository-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const active: ApiKeyRecord = {
    id: 'active-key',
    name: 'Active key',
    ownerId: 'member@example.com',
    status: 'approved',
    hash: 'active-hash',
    createdAt: 100,
    expiresAt: 1_000,
  };
  const rotated: ApiKeyRecord = {
    id: 'rotated-key',
    name: 'Rotated key',
    ownerId: 'member@example.com',
    status: 'approved',
    hash: 'replacement-hash',
    previousHash: 'grace-hash',
    previousHashExpiresAt: 2_000,
    createdAt: 200,
  };
  const pending: ApiKeyRecord = {
    id: 'pending-key',
    name: 'Pending key',
    ownerId: 'member@example.com',
    status: 'pending',
    hash: 'pending-hash',
    createdAt: 300,
  };
  const zeroExpiry: ApiKeyRecord = {
    id: 'zero-expiry-key',
    name: 'Legacy zero-expiry key',
    ownerId: 'member@example.com',
    status: 'approved',
    hash: 'zero-expiry-hash',
    createdAt: 400,
    expiresAt: 0,
  };
  const duplicateCurrentHash: ApiKeyRecord = {
    ...active,
    id: 'duplicate-current-hash',
    name: 'Newer duplicate key',
    createdAt: 500,
  };
  const earlierGraceHash: ApiKeyRecord = {
    ...rotated,
    id: 'earlier-grace-hash',
    hash: 'new-hash',
    previousHash: 'shared-hash',
    createdAt: 600,
  };
  const laterCurrentHash: ApiKeyRecord = {
    ...active,
    id: 'later-current-hash',
    hash: 'shared-hash',
    createdAt: 700,
  };

  try {
    const firstDatabase = openStateDatabase(options);
    try {
      createApiKeyRepository(firstDatabase.db).replaceAll([active, rotated, pending, zeroExpiry, duplicateCurrentHash, earlierGraceHash, laterCurrentHash]);
    } finally {
      firstDatabase.close();
    }

    const reopenedDatabase = openStateDatabase(options);
    try {
      const repository = createApiKeyRepository(reopenedDatabase.db);

      expect(repository.findApprovedByHash('active-hash', 1_000)).toEqual(active);
      expect(repository.findApprovedByHash('active-hash', 1_001)).toBeUndefined();
      expect(repository.findApprovedByHash('grace-hash', 1_999)).toEqual(rotated);
      expect(repository.findApprovedByHash('grace-hash', 2_000)).toBeUndefined();
      expect(repository.findApprovedByHash('pending-hash', 500)).toBeUndefined();
      expect(repository.findApprovedByHash('zero-expiry-hash', 1_000)).toEqual(zeroExpiry);
      expect(repository.findApprovedByHash('active-hash', 500)).toEqual(active);
      expect(repository.findApprovedByHash('shared-hash', 500)).toEqual(earlierGraceHash);
    } finally {
      reopenedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('API key lookup columns migrate without changing existing records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-repository-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const legacy: ApiKeyRecord = {
    id: 'legacy-api-key',
    name: 'Legacy API key',
    ownerId: 'Member@Example.com',
    status: 'approved',
    hash: 'legacy-hash',
    previousHash: 'legacy-grace-hash',
    previousHashExpiresAt: 2_000,
    createdAt: 100,
    expiresAt: 3_000,
  };

  try {
    const existingDatabase = openStateDatabase(options);
    existingDatabase.writeState({ version: 18, apiKeys: [legacy] });
    existingDatabase.db.exec(`
      DROP INDEX api_keys_by_owner_created;
      DROP INDEX api_keys_by_status_created;
      DROP INDEX api_keys_by_current_hash;
      DROP INDEX api_keys_by_previous_hash;
      DROP INDEX api_keys_by_expiry;
      ALTER TABLE api_keys DROP COLUMN expires_at;
      ALTER TABLE api_keys DROP COLUMN created_at;
      ALTER TABLE api_keys DROP COLUMN previous_hash_expires_at;
      ALTER TABLE api_keys DROP COLUMN previous_hash;
      ALTER TABLE api_keys DROP COLUMN key_hash;
      ALTER TABLE api_keys DROP COLUMN status;
      ALTER TABLE api_keys DROP COLUMN owner_id;
      DELETE FROM schema_migrations WHERE version = 19;
    `);
    existingDatabase.close();

    const migratedDatabase = openStateDatabase(options);
    try {
      expect(migratedDatabase.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      expect(migratedDatabase.readState()).toMatchObject({ apiKeys: [legacy] });
      const repository = createApiKeyRepository(migratedDatabase.db);
      expect(repository.findApprovedByHash('legacy-grace-hash', 1_999)).toEqual(legacy);
      expect(repository.listByOwner('member@example.com')).toEqual([legacy]);
    } finally {
      migratedDatabase.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('API key page search preserves JavaScript Unicode case folding', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-api-key-repository-unicode-'));
  try {
    const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
    try {
      const repository = createApiKeyRepository(database.db);
      repository.replaceAll([{
        id: 'unicode-key',
        name: 'ÅPp-Key',
        ownerId: 'MÜNCHEN@example.com',
        status: 'approved',
        createdAt: 100,
      }]);

      expect(repository.listPage(0, 10, 'åpp-key')).toEqual({
        records: [expect.objectContaining({ id: 'unicode-key' })],
        total: 1,
      });
      expect(repository.listPage(0, 10, 'münchen')).toEqual({
        records: [expect.objectContaining({ id: 'unicode-key' })],
        total: 1,
      });
    } finally {
      database.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
