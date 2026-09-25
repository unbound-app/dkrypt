import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import {
  artifactFileAvailable,
  getArtifactById,
  getArtifactStorageStats,
  listArtifacts,
  promoteArtifact,
  reconcileArtifactStore,
  touchArtifact,
} from './artifacts.js';

async function stagingFile(contents: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dkrypt-artifact-test-'));
  const file = path.join(directory, 'source.ipa');
  await writeFile(file, contents);
  return file;
}

describe('persistent artifact store', () => {
  test('promotes atomically, records metadata, and updates access time', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const stagingPath = await stagingFile('first ipa');
    const artifact = await promoteArtifact({
      key: `test-promote-${crypto.randomUUID()}`,
      bundleId: 'com.example.promote',
      channel: 'appstore',
      externalVersionId: '123',
      versionLabel: '342.0',
      stagingPath,
    });

    expect(artifact.fileSizeBytes).toBe(9);
    expect(artifact.sha256).toHaveLength(64);
    expect(artifactFileAvailable(artifact)).toBe(true);
    expect(getArtifactById(artifact.id)?.filePath).toBe(artifact.filePath);
    const before = artifact.accessCount;
    await touchArtifact(artifact);
    expect(getArtifactById(artifact.id)?.accessCount).toBe(before + 1);
  });

  test('serializes promotion and evicts the least recently accessed artifact', async () => {
    config.artifactMaxBytes = 7;
    const first = await promoteArtifact({
      key: `test-lru-first-${crypto.randomUUID()}`,
      bundleId: 'com.example.lru',
      channel: 'appstore',
      externalVersionId: 'first',
      stagingPath: await stagingFile('1234'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const second = await promoteArtifact({
      key: `test-lru-second-${crypto.randomUUID()}`,
      bundleId: 'com.example.lru',
      channel: 'appstore',
      externalVersionId: 'second',
      stagingPath: await stagingFile('5678'),
    });

    expect(getArtifactById(first.id)).toBeUndefined();
    expect(getArtifactById(second.id)).toBeDefined();
    expect(getArtifactStorageStats().usedBytes).toBe(4);
  });

  test('rejects an artifact larger than the quota without promoting it', async () => {
    config.artifactMaxBytes = 3;
    const stagingPath = await stagingFile('1234');
    await expect(
      promoteArtifact({
        key: `test-oversized-${crypto.randomUUID()}`,
        bundleId: 'com.example.oversized',
        channel: 'testflight',
        testflightBuildId: 109440,
        stagingPath,
      }),
    ).rejects.toThrow(/larger than/);
    await expect(rm(stagingPath)).resolves.toBeUndefined();
  });

  test('does not promote an artifact after the job has been aborted', async () => {
    const stagingPath = await stagingFile('cancelled ipa');
    const controller = new AbortController();
    controller.abort(new Error('job deadline exceeded'));

    await expect(promoteArtifact({
      key: `test-aborted-${crypto.randomUUID()}`,
      bundleId: 'com.example.aborted',
      channel: 'appstore',
      stagingPath,
      signal: controller.signal,
    })).rejects.toThrow('job deadline exceeded');

    expect(existsSync(stagingPath)).toBe(true);
    await rm(stagingPath, { force: true });
  });

  test('reconcile removes stale partials and unindexed IPA files', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const staging = path.join(config.artifactDir, '.staging');
    await mkdir(staging, { recursive: true });
    const partial = path.join(staging, 'partial.ipa');
    const orphan = path.join(config.artifactDir, 'orphan.ipa');
    await writeFile(partial, 'partial');
    await writeFile(orphan, 'orphan');
    await reconcileArtifactStore();

    await expect(rm(partial)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(rm(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('lists artifacts newest first with quota statistics', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    await promoteArtifact({
      key: `test-list-${crypto.randomUUID()}`,
      bundleId: 'com.example.list',
      channel: 'appstore',
      externalVersionId: '456',
      stagingPath: await stagingFile('listed ipa'),
    });
    const result = listArtifacts({ query: 'com.example.list' });
    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.totalBytes).toBeGreaterThan(0);
    expect(result.maxBytes).toBe(1024 * 1024);
  });

  test('applies bundle scopes before artifact pagination and storage totals', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const allowedBundleId = `com.example.scoped-${crypto.randomUUID().slice(0, 8)}`;
    const deniedBundleId = `com.example.other-${crypto.randomUUID().slice(0, 8)}`;
    const allowed = await promoteArtifact({
      key: `test-scoped-list-allowed-${crypto.randomUUID()}`,
      bundleId: allowedBundleId,
      channel: 'appstore',
      stagingPath: await stagingFile('allowed scoped ipa'),
    });
    const denied = await promoteArtifact({
      key: `test-scoped-list-denied-${crypto.randomUUID()}`,
      bundleId: deniedBundleId,
      channel: 'appstore',
      stagingPath: await stagingFile('denied scoped ipa'),
    });

    try {
      const result = listArtifacts({ bundleIds: [allowedBundleId] });
      expect(result.artifacts.map((artifact) => artifact.bundleId)).toEqual([allowedBundleId]);
      expect(result.total).toBe(1);
      expect(result.totalBytes).toBe(allowed.fileSizeBytes);
      expect(result.artifacts.some((artifact) => artifact.id === denied.id)).toBe(false);
    } finally {
      await rm(allowed.filePath, { force: true });
      await rm(denied.filePath, { force: true });
    }
  });

  test('stores Apple version and build metadata separately from TestFlight release tags', async () => {
    const key = `test-metadata-${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key,
      bundleId: 'com.example.metadata',
      channel: 'testflight',
      versionLabel: '344.0_109551',
      buildNumber: '109551',
      stagingPath: await stagingFile('metadata ipa'),
    });

    expect(artifact.versionLabel).toBe('344.0');
    expect(artifact.buildNumber).toBe('109551');

    const refreshed = await promoteArtifact({
      key,
      bundleId: 'com.example.metadata',
      channel: 'testflight',
      versionLabel: '344.0',
      buildNumber: '109551',
      stagingPath: await stagingFile('discarded ipa'),
    });
    expect(refreshed.versionLabel).toBe('344.0');
    expect(refreshed.buildNumber).toBe('109551');
  });
});
