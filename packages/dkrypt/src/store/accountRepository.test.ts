import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountRepository } from '#store/accountRepository.js';
import { openStateCollectionDatabase, replaceStateCollection } from '#store/sqlite.js';
import type { AllowedUser, Role } from '#store/state.js';

function user(username: string, addedAt: number): AllowedUser {
  return { username, roleIds: ['manager'], addedAt };
}

function role(id: string, position: number): Role {
  return {
    id,
    name: id,
    color: '#5865f2',
    permissions: '8192',
    position,
    isDefault: id === 'everyone',
    createdAt: position,
    updatedAt: position,
  };
}

async function withAccountRepository(run: (repository: ReturnType<typeof createAccountRepository>, database: ReturnType<typeof openStateCollectionDatabase>, stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-account-repository-'));
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['users', 'roles']);
  const repository = createAccountRepository(database);
  try {
    await run(repository, database, stateDir);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('account repository stores users by normalized username and preserves role records across restart', async () => {
  await withAccountRepository(async (repository, database, stateDir) => {
    const users = [user('adrian', 100), user('second-user', 200)];
    const roles = [role('everyone', 0), role('manager', 1)];
    repository.replaceAll([user('Adrian', 100), users[1]], roles);

    expect(database.query('SELECT id FROM users ORDER BY rowid ASC').all()).toEqual([
      { id: 'adrian' },
      { id: 'second-user' },
    ]);
    expect(repository.findUser('ADRIAN')).toEqual(users[0]);
    expect(repository.findRole('manager')).toEqual(roles[1]);

    const reopenedDatabase = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['users', 'roles']);
    try {
      const reopened = createAccountRepository(reopenedDatabase);
      expect(reopened.listUsers()).toEqual(users);
      expect(reopened.listRoles()).toEqual(roles);
    } finally {
      reopenedDatabase.close();
    }
  });
});

test('account repository rejects case-colliding usernames before replacing either collection', async () => {
  await withAccountRepository(async (repository) => {
    repository.replaceAll([user('existing', 1)], [role('everyone', 0)]);

    expect(() => repository.replaceAll([user('duplicate', 2), user('DUPLICATE', 3)], [role('everyone', 0)])).toThrow('account usernames must be unique ignoring case');
    expect(repository.listUsers()).toEqual([user('existing', 1)]);
  });
});

test('account repository detects legacy user row ids and keeps lookups available during migration', async () => {
  await withAccountRepository(async (repository, database) => {
    const legacyUser = user('Adrian', 100);
    replaceStateCollection(database, 'users', [{ id: 'user-0', payload: legacyUser, updatedAt: legacyUser.addedAt }]);

    expect(repository.hasCanonicalUserKeys()).toBe(false);
    expect(repository.findUser('ADRIAN')).toEqual(user('adrian', 100));

    repository.replaceAll([legacyUser], [role('everyone', 0)]);

    expect(repository.hasCanonicalUserKeys()).toBe(true);
    expect(repository.findUser('Adrian')).toEqual(user('adrian', 100));
  });
});

test('account repository rolls back users when writing a role fails', async () => {
  await withAccountRepository(async (repository, database) => {
    repository.replaceAll([user('existing', 1)], [role('everyone', 0)]);
    database.exec("CREATE TRIGGER reject_account_role_insert BEFORE INSERT ON roles BEGIN SELECT RAISE(ABORT, 'role write rejected'); END;");

    expect(() => repository.replaceAll([user('replacement', 2)], [role('everyone', 0)])).toThrow('role write rejected');
    expect(repository.listUsers()).toEqual([user('existing', 1)]);
    expect(repository.listRoles()).toEqual([role('everyone', 0)]);
  });
});
