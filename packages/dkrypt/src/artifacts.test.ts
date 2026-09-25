import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '#config.js';
import { createProject, exportBackup, importBackup } from '#store/state.js';
import {
  artifactFileAvailable,
  getArtifactById,
  getArtifactStorageStats,
  listArtifacts,
  previewArtifactQuotaRetention,
  promoteArtifact,
  reloadArtifactIndex,
  reconcileArtifactStore,
  setArtifactPinned,
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

  test('pinned artifacts survive quota pressure and can be evicted after unpinning', async () => {
    config.artifactMaxBytes = 4;
    const protectedArtifact = await promoteArtifact({
      key: `test-pinned-${crypto.randomUUID()}`,
      bundleId: 'com.example.pinned',
      channel: 'appstore',
      externalVersionId: 'pinned',
      stagingPath: await stagingFile('1234'),
    });

    const pinned = await setArtifactPinned(protectedArtifact.id, true);
    expect(pinned.changed).toBe(true);
    expect(pinned.artifact?.pinnedAt).toBeTypeOf('number');
    reloadArtifactIndex();
    expect(getArtifactById(protectedArtifact.id)?.pinnedAt).toBe(pinned.artifact?.pinnedAt);

    const preview = previewArtifactQuotaRetention(1);
    expect(preview).toMatchObject({ pinnedCount: 1, pinnedBytes: 4, retainedCount: 1, retainedBytes: 4, evictedCount: 0, remainingOverQuotaBytes: 3 });
    await expect(promoteArtifact({
      key: `test-pinned-blocked-${crypto.randomUUID()}`,
      bundleId: 'com.example.pinned-blocked',
      channel: 'appstore',
      stagingPath: await stagingFile('x'),
    })).rejects.toThrow('unable to free enough artifact storage');
    expect(artifactFileAvailable(getArtifactById(protectedArtifact.id))).toBe(true);
    await expect(setArtifactPinned(protectedArtifact.id, true)).resolves.toMatchObject({ changed: false });

    const unpinned = await setArtifactPinned(protectedArtifact.id, false);
    expect(unpinned.changed).toBe(true);
    expect(unpinned.artifact?.pinnedAt).toBeUndefined();
    const replacement = await promoteArtifact({
      key: `test-after-unpin-${crypto.randomUUID()}`,
      bundleId: 'com.example.after-unpin',
      channel: 'appstore',
      stagingPath: await stagingFile('5678'),
    });
    expect(getArtifactById(protectedArtifact.id)).toBeUndefined();
    expect(artifactFileAvailable(replacement)).toBe(true);
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

  test('keeps artifact availability scoped to the projects that can access it', async () => {
    const bundleId = `com.example.project.${crypto.randomUUID()}`;
    const artifact = await promoteArtifact({
      key: `test-project-scope-${crypto.randomUUID()}`,
      bundleId,
      channel: 'appstore',
      externalVersionId: '789',
      projectId: 'project-a',
      stagingPath: await stagingFile('project ipa'),
    });

    expect(artifact.projectIds).toEqual(['project-a']);
    expect(listArtifacts({ projectIds: ['project-a'], query: bundleId }).total).toBe(1);
    expect(listArtifacts({ projectIds: ['project-b'], query: bundleId }).total).toBe(0);

    const linked = await promoteArtifact({
      key: artifact.key,
      bundleId,
      channel: 'appstore',
      externalVersionId: '789',
      projectId: 'project-b',
      stagingPath: await stagingFile('duplicate project ipa'),
    });

    expect(linked.id).toBe(artifact.id);
    expect(linked.projectIds).toEqual(['project-a', 'project-b']);
    expect(listArtifacts({ projectIds: ['project-b'], query: bundleId }).total).toBe(1);
  });

  test('enforces a project storage quota before promoting an artifact', async () => {
    const project = createProject({ name: `Storage quota ${crypto.randomUUID()}`, storageQuotaBytes: 3 }, 'root').project!;
    const stagingPath = await stagingFile('four');

    await expect(promoteArtifact({
      key: `test-project-quota-${crypto.randomUUID()}`,
      bundleId: `com.example.project-quota.${crypto.randomUUID()}`,
      channel: 'appstore',
      projectId: project.id,
      stagingPath,
    })).rejects.toThrow('project storage quota would be exceeded');
    await rm(stagingPath, { force: true });
  });

  test('backup restore preserves artifact project links without exposing file paths', async () => {
    const project = createProject({ name: `Artifact backup ${crypto.randomUUID()}` }, 'root').project!;
    const artifact = await promoteArtifact({
      key: `test-artifact-backup-${crypto.randomUUID()}`,
      bundleId: `com.example.artifact-backup.${crypto.randomUUID()}`,
      channel: 'appstore',
      projectId: project.id,
      stagingPath: await stagingFile('backup ipa'),
    });
    const backup = exportBackup();
    const link = backup.artifactProjectLinks.find((entry) => entry.artifactId === artifact.id);

    expect(link).toEqual({ artifactId: artifact.id, projectIds: [project.id] });
    expect(JSON.stringify(link)).not.toContain(artifact.filePath);

    const changedLinks = backup.artifactProjectLinks.map((entry) => entry.artifactId === artifact.id ? { ...entry, projectIds: ['default'] } : entry);
    expect(importBackup({ ...backup, artifactProjectLinks: changedLinks }, 'test').ok).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(artifact.id)?.projectIds).toEqual(['default']);

    expect(importBackup(backup, 'test').ok).toBe(true);
    reloadArtifactIndex();
    expect(getArtifactById(artifact.id)?.projectIds).toEqual([project.id]);
  });

  test('previews least-recently-used quota evictions without changing artifact storage', async () => {
    config.artifactMaxBytes = 1024 * 1024;
    const existing = listArtifacts({ limit: 200 }).artifacts;
    const oldest = await promoteArtifact({
      key: `test-retention-preview-oldest-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('aaaa'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await promoteArtifact({
      key: `test-retention-preview-middle-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('bbbb'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await promoteArtifact({
      key: `test-retention-preview-newest-${crypto.randomUUID()}`,
      bundleId: 'com.example.retention-preview',
      channel: 'appstore',
      stagingPath: await stagingFile('cccc'),
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (const artifact of existing) await touchArtifact(artifact);

    const before = listArtifacts({ limit: 200 }).artifacts;
    const beforeStats = getArtifactStorageStats();
    const targetMaxBytes = beforeStats.usedBytes - oldest.fileSizeBytes;
    const preview = previewArtifactQuotaRetention(targetMaxBytes);

    expect(preview.currentBytes).toBe(beforeStats.usedBytes);
    expect(preview.targetMaxBytes).toBe(targetMaxBytes);
    expect(preview.evictedCount).toBe(1);
    expect(preview.evictionExamples.map((artifact) => artifact.id)).toEqual([oldest.id]);
    expect(preview.retainedCount).toBe(before.length - 1);
    expect(preview.retainedBytes).toBeLessThanOrEqual(targetMaxBytes);
    expect(preview.currentBytes - preview.retainedBytes).toBe(preview.reclaimedBytes);
    expect(getArtifactStorageStats().usedBytes).toBe(beforeStats.usedBytes);
    expect(before.every(artifactFileAvailable)).toBe(true);
  });

  test('rejects invalid simulated artifact quotas', () => {
    expect(() => previewArtifactQuotaRetention(0)).toThrow('artifact quota must be a positive safe integer');
    expect(() => previewArtifactQuotaRetention(Number.MAX_SAFE_INTEGER + 1)).toThrow('artifact quota must be a positive safe integer');
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
