import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createArtifactRepository } from '#artifacts/repository.js';
import type { ArtifactRecord } from '#artifactTypes.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

function createArtifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-1',
    key: 'com.example.app|appstore|version:1.0',
    projectIds: ['workspace-a'],
    bundleId: 'com.example.app',
    channel: 'appstore',
    versionLabel: '1.0',
    buildNumber: '10',
    filePath: '/artifacts/1.ipa',
    fileSizeBytes: 100,
    sha256: 'a'.repeat(64),
    createdAt: 100,
    lastAccessedAt: 120,
    accessCount: 2,
    sourceJobId: 'job-1',
    ...overrides,
  };
}

test('artifact repository upgrades legacy metadata and supports indexed lookups', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-migration-'));
  const databasePath = path.join(stateDir, 'state.sqlite');
  const legacyDatabase = new Database(databasePath, { create: true, strict: true });
  legacyDatabase.exec('CREATE TABLE artifacts (id TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);');
  const legacyArtifact = createArtifact({ id: 'legacy-artifact', key: 'legacy-key', sourceJobId: 'legacy-job' });
  legacyDatabase.query('INSERT INTO artifacts (id, payload, updated_at) VALUES (?, ?, ?)').run(legacyArtifact.id, JSON.stringify(legacyArtifact), legacyArtifact.lastAccessedAt);
  legacyDatabase.close();

  let repository: ReturnType<typeof createArtifactRepository> | undefined;
  try {
    repository = createArtifactRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['artifacts']));
    expect(repository.findByKey('legacy-key')).toEqual(legacyArtifact);
    expect(repository.findBySourceJobId('legacy-job')).toEqual(legacyArtifact);
    expect(repository.load()).toEqual([legacyArtifact]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('artifact repository keeps records and indexed lookups across restart', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-artifact-repository-restart-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let repository: ReturnType<typeof createArtifactRepository> | undefined;

  try {
    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    const first = createArtifact();
    const second = createArtifact({ id: 'artifact-2', key: 'com.example.app|testflight|42', channel: 'testflight', testflightBuildId: 42, sourceJobId: 'job-2', lastAccessedAt: 130 });
    repository.replace([first, second]);
    expect(repository.findById('artifact-2')).toEqual(second);
    expect(repository.findByKey(first.key)).toEqual(first);
    repository.close();
    repository = undefined;

    repository = createArtifactRepository(openStateCollectionDatabase(options, ['artifacts']));
    expect(repository.findBySourceJobId('job-2')).toEqual(second);
    expect(repository.load()).toEqual([second, first]);
  } finally {
    repository?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
