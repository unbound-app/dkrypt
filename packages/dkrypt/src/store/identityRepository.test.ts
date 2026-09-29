import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createIdentityRepository } from '#store/identityRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import type { AuthProfile } from '#identity.js';

function createProfile(overrides: Partial<AuthProfile> = {}): AuthProfile {
  return {
    userId: 'github:user-1',
    provider: 'github',
    providerId: 'provider-user-1',
    username: 'user-one',
    displayName: 'User One',
    identities: [{
      provider: 'github',
      providerId: 'provider-user-1',
      username: 'user-one',
      displayName: 'User One',
      source: 'oauth',
      updatedAt: '2026-09-29T12:00:00.000Z',
    }],
    updatedAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

async function withIdentityRepository(
  run: (openRepository: () => ReturnType<typeof createIdentityRepository>) => Promise<void>,
): Promise<void> {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-identity-repository-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createIdentityRepository> | undefined;
  const openRepository = () => {
    repository?.close();
    repository = createIdentityRepository(openStateCollectionDatabase(options, ['auth_profiles']));
    return repository;
  };

  try {
    await run(openRepository);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('identity profiles remain addressable and update individually across restart', async () => {
  await withIdentityRepository(async (openRepository) => {
    const first = createProfile();
    const second = createProfile({ userId: 'discord:user-2', provider: 'discord', providerId: 'provider-user-2', username: 'user-two', displayName: 'User Two' });
    const repository = openRepository();
    repository.save(first);
    repository.save(second);
    repository.save({ ...first, customDisplayName: 'Custom User One', displayName: 'Custom User One' });
    expect(repository.findByUserId(first.userId)).toMatchObject({ customDisplayName: 'Custom User One', displayName: 'Custom User One' });

    const restartedRepository = openRepository();
    expect(restartedRepository.findByUserId(first.userId)).toMatchObject({ customDisplayName: 'Custom User One' });
    expect(restartedRepository.listAll()).toHaveLength(2);
    expect(restartedRepository.deleteByUserId(second.userId)).toBe(true);
    expect(restartedRepository.findByUserId(second.userId)).toBeUndefined();
  });
});

test('identity profile merges replace the source record durably', async () => {
  await withIdentityRepository(async (openRepository) => {
    const target = createProfile({ userId: 'github:target', displayName: 'Target' });
    const source = createProfile({ userId: 'discord:source', provider: 'discord', providerId: 'provider-source', username: 'source', displayName: 'Source' });
    const repository = openRepository();
    repository.save(target);
    repository.save(source);
    repository.applyChanges({
      upserts: [{ ...target, aliases: [source.userId], identities: [...(target.identities ?? []), ...(source.identities ?? [])] }],
      deletedUserIds: [source.userId],
    });

    const restartedRepository = openRepository();
    expect(restartedRepository.findByUserId(target.userId)?.aliases).toEqual([source.userId]);
    expect(restartedRepository.findByUserId(source.userId)).toBeUndefined();
    expect(restartedRepository.listAll()).toHaveLength(1);
  });
});

test('legacy identity snapshots are imported only once into an empty repository', async () => {
  await withIdentityRepository(async (openRepository) => {
    const legacy = createProfile({ userId: 'github:legacy' });
    const repository = openRepository();
    repository.importLegacySnapshot(() => [legacy]);
    expect(repository.findByUserId(legacy.userId)).toEqual(legacy);
    expect(repository.deleteByUserId(legacy.userId)).toBe(true);

    const restartedRepository = openRepository();
    expect(restartedRepository.importLegacySnapshot(() => { throw new Error('legacy snapshot should not be read'); })).toBeUndefined();
    expect(restartedRepository.listAll()).toEqual([]);
  });
});

test('missing legacy snapshots do not prevent a later import', async () => {
  await withIdentityRepository(async (openRepository) => {
    const legacy = createProfile({ userId: 'github:restored-legacy' });
    const repository = openRepository();
    repository.importLegacySnapshot(() => undefined);

    const restartedRepository = openRepository();
    restartedRepository.importLegacySnapshot(() => [legacy]);
    expect(restartedRepository.findByUserId(legacy.userId)).toEqual(legacy);
  });
});

test('existing SQLite identities prevent legacy snapshot loading', async () => {
  await withIdentityRepository(async (openRepository) => {
    const current = createProfile({ userId: 'github:current' });
    const legacy = createProfile({ userId: 'github:legacy' });
    const repository = openRepository();
    repository.save(current);
    let loaderCalled = false;
    repository.importLegacySnapshot(() => {
      loaderCalled = true;
      return [legacy];
    });

    expect(loaderCalled).toBe(false);
    expect(repository.findByUserId(current.userId)).toEqual(current);
    expect(repository.findByUserId(legacy.userId)).toBeUndefined();
  });
});
