import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { throwIfAborted } from '#util/abort.js';

const log = scopedLogger('artifacts');

export type ArtifactChannel = 'appstore' | 'testflight';

export interface ArtifactRecord {
  id: string;
  key: string;
  bundleId: string;
  channel: ArtifactChannel;
  externalVersionId?: string;
  testflightBuildId?: number;
  versionLabel?: string;
  buildNumber?: string;
  filePath: string;
  fileSizeBytes: number;
  sha256: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  sourceJobId?: string;
}

export interface ArtifactListOptions {
  offset?: number;
  limit?: number;
  query?: string;
  channel?: ArtifactChannel;
  bundleIds?: string[];
}

export interface ArtifactListResult {
  artifacts: ArtifactRecord[];
  total: number;
  totalBytes: number;
  maxBytes: number;
}

export interface ArtifactQuotaRetentionPreview {
  targetMaxBytes: number;
  currentMaxBytes: number;
  currentCount: number;
  currentBytes: number;
  retainedCount: number;
  retainedBytes: number;
  evictedCount: number;
  reclaimedBytes: number;
  evictionExamples: Array<Pick<ArtifactRecord, 'id' | 'bundleId' | 'channel' | 'versionLabel' | 'fileSizeBytes' | 'lastAccessedAt'>>;
  additionalEvictions: number;
}

interface ArtifactIndex {
  version: 1;
  artifacts: ArtifactRecord[];
}

const indexPath = path.join(config.stateDir, 'artifacts.json');
const stagingDir = path.join(config.artifactDir, '.staging');
const artifactDatabase = openStateCollectionDatabase(
  {
    stateDir: config.stateDir,
    filename: config.stateDatabaseFile,
    busyTimeoutMs: config.stateDbBusyTimeoutMs,
    migrationDryRun: config.stateDbMigrationDryRun,
  },
  ['artifacts'],
);
let index: ArtifactIndex = loadIndex();
let mutationChain = Promise.resolve();

function normalizeArtifactVersionLabel(value: string | undefined, channel: ArtifactChannel): string | undefined {
  const normalized = value?.trim().replace(/^TestFlight\s+/i, '').replace(/^v(?=\d)/i, '');
  if (!normalized) return undefined;
  if (channel === 'testflight') {
    const separator = normalized.indexOf('_');
    if (separator > 0) return normalized.slice(0, separator);
  }
  return normalized;
}

function normalizeArtifactRecord(record: ArtifactRecord): ArtifactRecord {
  const versionLabel = normalizeArtifactVersionLabel(record.versionLabel, record.channel);
  return versionLabel === record.versionLabel ? record : { ...record, versionLabel };
}

function loadIndex(): ArtifactIndex {
  mkdirSync(config.stateDir, { recursive: true });
  const stored = readStateCollection(artifactDatabase, 'artifacts');
  const storedArtifacts = stored.filter(isArtifactRecord).map(normalizeArtifactRecord);
  if (storedArtifacts.length > 0) return { version: 1, artifacts: storedArtifacts };
  if (!existsSync(indexPath)) return { version: 1, artifacts: [] };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<ArtifactIndex>;
    if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) throw new Error('unsupported artifact index');
    const artifacts = parsed.artifacts.filter(isArtifactRecord).map(normalizeArtifactRecord);
    replaceStateCollection(artifactDatabase, 'artifacts', artifacts.map((artifact) => ({ id: artifact.id, payload: artifact, updatedAt: artifact.lastAccessedAt })));
    return { version: 1, artifacts };
  } catch (err) {
    throw new Error(`could not initialize artifact metadata: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ArtifactRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.key === 'string' &&
    typeof record.bundleId === 'string' &&
    (record.channel === 'appstore' || record.channel === 'testflight') &&
    typeof record.filePath === 'string' &&
    typeof record.fileSizeBytes === 'number' &&
    typeof record.sha256 === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.lastAccessedAt === 'number' &&
    typeof record.accessCount === 'number'
  );
}

function persistIndex(): void {
  mkdirSync(config.stateDir, { recursive: true });
  replaceStateCollection(artifactDatabase, 'artifacts', index.artifacts.map((artifact) => ({ id: artifact.id, payload: artifact, updatedAt: artifact.lastAccessedAt })));
  const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(index));
    renameSync(temporary, indexPath);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch (cleanupError) {
      log.warn('failed to remove a temporary compatibility artifact index', { path: temporary, error: String(cleanupError) });
    }
    log.warn('failed to refresh the compatibility artifact index after persisting metadata', { error: String(error) });
  }
}

export function closeArtifactDatabase(): void {
  artifactDatabase.close();
}

function withMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.then(() => undefined, () => undefined);
  return next;
}

function updateArtifactMetadata(artifact: ArtifactRecord, channel: ArtifactChannel, versionLabel?: string, buildNumber?: string): boolean {
  const normalizedVersion = normalizeArtifactVersionLabel(versionLabel, channel);
  const normalizedBuild = buildNumber?.trim() || undefined;
  let changed = false;
  if (normalizedVersion && artifact.versionLabel !== normalizedVersion) {
    artifact.versionLabel = normalizedVersion;
    changed = true;
  }
  if (normalizedBuild && artifact.buildNumber !== normalizedBuild) {
    artifact.buildNumber = normalizedBuild;
    changed = true;
  }
  return changed;
}

export function artifactKeyForAppStore(bundleId: string, externalVersionId: string): string {
  return `${bundleId}|appstore|${externalVersionId}`;
}

export function artifactKeyForAppStoreVersion(bundleId: string, versionLabel: string, externalVersionId?: string): string {
  return externalVersionId ? artifactKeyForAppStore(bundleId, externalVersionId) : `${bundleId}|appstore|version:${versionLabel}`;
}

export function artifactKeyForTestFlight(bundleId: string, buildId: number): string {
  return `${bundleId}|testflight|${buildId}`;
}

export function artifactKeyForJob(job: {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number } };
  versionLabel?: string;
}): string {
  if (job.testflight) return artifactKeyForTestFlight(job.bundleId, job.testflight.build.id);
  if (job.externalVersionId) return artifactKeyForAppStore(job.bundleId, job.externalVersionId);
  if (job.versionLabel && job.versionLabel !== 'Current App Store release') {
    return artifactKeyForAppStoreVersion(job.bundleId, job.versionLabel);
  }
  return `${job.bundleId}|legacy|${job.id}`;
}

export function migrateLegacyPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  if (existsSync(filePath)) return filePath;
  const basename = path.basename(filePath);
  const migrated = path.join(config.artifactDir, basename);
  return existsSync(migrated) ? migrated : undefined;
}

export function getArtifactById(id: string): ArtifactRecord | undefined {
  return index.artifacts.find((artifact) => artifact.id === id);
}

export function getArtifactBySourceJobId(jobId: string): ArtifactRecord | undefined {
  return index.artifacts.find((artifact) => artifact.sourceJobId === jobId);
}

export function getArtifactByKey(key: string): ArtifactRecord | undefined {
  const artifact = index.artifacts.find((candidate) => candidate.key === key);
  if (!artifact || !existsSync(artifact.filePath)) return undefined;
  return artifact;
}

export function artifactFileAvailable(artifact: ArtifactRecord | undefined): boolean {
  return !!artifact && existsSync(artifact.filePath);
}

export function getArtifactStorageStats(bundleIds?: string[]): { usedBytes: number; maxBytes: number; count: number } {
  const available = index.artifacts
    .filter((artifact) => existsSync(artifact.filePath))
    .filter((artifact) => !bundleIds || bundleIds.includes(artifact.bundleId));
  return {
    usedBytes: available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    maxBytes: config.artifactMaxBytes,
    count: available.length,
  };
}

export function previewArtifactQuotaRetention(targetMaxBytes: number): ArtifactQuotaRetentionPreview {
  if (!Number.isSafeInteger(targetMaxBytes) || targetMaxBytes < 1) {
    throw new Error('artifact quota must be a positive safe integer');
  }
  const available = index.artifacts.filter((artifact) => existsSync(artifact.filePath));
  const evicted = planArtifactEvictions(available, 0, targetMaxBytes, new Set());
  const evictedIds = new Set(evicted.map((artifact) => artifact.id));
  const retained = available.filter((artifact) => !evictedIds.has(artifact.id));
  const currentBytes = available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  const reclaimedBytes = evicted.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  return {
    targetMaxBytes,
    currentMaxBytes: config.artifactMaxBytes,
    currentCount: available.length,
    currentBytes,
    retainedCount: retained.length,
    retainedBytes: retained.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    evictedCount: evicted.length,
    reclaimedBytes,
    evictionExamples: evicted.slice(0, 8).map(({ id, bundleId, channel, versionLabel, fileSizeBytes, lastAccessedAt }) => ({
      id,
      bundleId,
      channel,
      versionLabel,
      fileSizeBytes,
      lastAccessedAt,
    })),
    additionalEvictions: Math.max(0, evicted.length - 8),
  };
}

export function listArtifacts(options: ArtifactListOptions = {}): ArtifactListResult {
  const query = options.query?.trim().toLowerCase();
  const filtered = index.artifacts
    .filter((artifact) => artifactFileAvailable(artifact))
    .filter((artifact) => !options.bundleIds || options.bundleIds.includes(artifact.bundleId))
    .filter((artifact) => !options.channel || artifact.channel === options.channel)
    .filter((artifact) => {
      if (!query) return true;
      return [artifact.bundleId, artifact.versionLabel, artifact.externalVersionId, artifact.buildNumber, artifact.sha256]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(query));
    })
    .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);

  const offset = Math.max(options.offset ?? 0, 0);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const stats = getArtifactStorageStats(options.bundleIds);
  return {
    artifacts: filtered.slice(offset, offset + limit),
    total: filtered.length,
    totalBytes: stats.usedBytes,
    maxBytes: stats.maxBytes,
  };
}

export async function touchArtifact(artifact: ArtifactRecord): Promise<void> {
  await withMutation(async () => {
    touchArtifactUnsafe(artifact);
  });
}

function touchArtifactUnsafe(artifact: ArtifactRecord): void {
  const current = index.artifacts.find((candidate) => candidate.id === artifact.id);
  if (!current) return;
  current.lastAccessedAt = Date.now();
  current.accessCount += 1;
  persistIndex();
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function planArtifactEvictions(
  available: ArtifactRecord[],
  requiredBytes: number,
  maxBytes: number,
  protectedKeys: Set<string>,
): ArtifactRecord[] {
  let usedBytes = available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0);
  if (requiredBytes > maxBytes) {
    throw new Error(`artifact is ${requiredBytes} bytes, larger than the ${maxBytes}-byte storage limit`);
  }

  const candidates = available
    .filter((artifact) => !protectedKeys.has(artifact.key))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.createdAt - b.createdAt);
  const evictions: ArtifactRecord[] = [];

  for (const candidate of candidates) {
    if (usedBytes + requiredBytes <= maxBytes) break;
    evictions.push(candidate);
    usedBytes -= candidate.fileSizeBytes;
  }

  if (usedBytes + requiredBytes > maxBytes) {
    throw new Error('unable to free enough artifact storage');
  }

  return evictions;
}

function artifactsToEvict(requiredBytes: number, protectedKeys: Set<string>): ArtifactRecord[] {
  const available = index.artifacts.filter((artifact) => existsSync(artifact.filePath));
  return planArtifactEvictions(available, requiredBytes, config.artifactMaxBytes, protectedKeys);
}

export async function promoteArtifact(input: {
  key: string;
  bundleId: string;
  channel: ArtifactChannel;
  externalVersionId?: string;
  testflightBuildId?: number;
  versionLabel?: string;
  buildNumber?: string;
  stagingPath: string;
  sourceJobId?: string;
  signal?: AbortSignal;
}): Promise<ArtifactRecord> {
  return withMutation(async () => {
    throwIfAborted(input.signal);
    await mkdir(config.artifactDir, { recursive: true });
    throwIfAborted(input.signal);
    const existing = getArtifactByKey(input.key);
    if (existing) {
      await rm(input.stagingPath, { force: true });
      throwIfAborted(input.signal);
      if (updateArtifactMetadata(existing, input.channel, input.versionLabel, input.buildNumber)) persistIndex();
      touchArtifactUnsafe(existing);
      return existing;
    }

    const file = await stat(input.stagingPath);
    throwIfAborted(input.signal);
    const sha256 = await sha256File(input.stagingPath);
    throwIfAborted(input.signal);
    const previousArtifacts = index.artifacts;
    const staleArtifacts = previousArtifacts.filter((artifact) => !existsSync(artifact.filePath));
    const evictedArtifacts = artifactsToEvict(file.size, new Set([input.key]));
    throwIfAborted(input.signal);
    const now = Date.now();
    const artifact: ArtifactRecord = {
      id: randomUUID(),
      key: input.key,
      bundleId: input.bundleId,
      channel: input.channel,
      externalVersionId: input.externalVersionId,
      testflightBuildId: input.testflightBuildId,
      versionLabel: normalizeArtifactVersionLabel(input.versionLabel, input.channel),
      buildNumber: input.buildNumber?.trim() || undefined,
      filePath: path.join(config.artifactDir, `${now}-${randomUUID()}.ipa`),
      fileSizeBytes: file.size,
      sha256,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceJobId: input.sourceJobId,
    };
    await rename(input.stagingPath, artifact.filePath);
    if (input.signal?.aborted) {
      await rm(artifact.filePath, { force: true }).catch((error) => log.warn('failed to remove an artifact after cancellation', { path: artifact.filePath, error: String(error) }));
      throwIfAborted(input.signal);
    }
    const removedIds = new Set([...staleArtifacts, ...evictedArtifacts].map((candidate) => candidate.id));
    index.artifacts = [...previousArtifacts.filter((candidate) => !removedIds.has(candidate.id)), artifact];
    try {
      persistIndex();
    } catch (error) {
      index.artifacts = previousArtifacts;
      await rm(artifact.filePath, { force: true }).catch((cleanupError) => log.warn('failed to remove an artifact after promotion failed', { path: artifact.filePath, error: String(cleanupError) }));
      throw error;
    }
    for (const evicted of evictedArtifacts) {
      try {
        rmSync(evicted.filePath, { force: true });
        log.info('evicted artifact for storage quota', { artifactId: evicted.id, bundleId: evicted.bundleId, sizeBytes: evicted.fileSizeBytes });
      } catch (error) {
        log.warn('failed to remove an evicted artifact file', { artifactId: evicted.id, path: evicted.filePath, error: String(error) });
      }
    }
    for (const stale of staleArtifacts) {
      try {
        rmSync(stale.filePath, { force: true });
      } catch (error) {
        log.warn('failed to remove a stale artifact file', { artifactId: stale.id, path: stale.filePath, error: String(error) });
      }
    }
    return artifact;
  });
}

export async function registerLegacyJobArtifact(job: {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
  ipaMetadata?: { shortVersion?: string; bundleVersion?: string };
  filePath?: string;
  fileSizeBytes?: number;
}): Promise<ArtifactRecord | undefined> {
  const migratedPath = migrateLegacyPath(job.filePath);
  if (!migratedPath) return undefined;
  return withMutation(async () => {
    const key = artifactKeyForJob(job);
    const existing = getArtifactByKey(key);
    const channel = job.testflight ? 'testflight' : 'appstore';
    const versionLabel = job.ipaMetadata?.shortVersion ?? job.testflight?.build.cfBundleShortVersion ?? job.versionLabel;
    const buildNumber = job.ipaMetadata?.bundleVersion ?? job.testflight?.build.cfBundleVersion;
    if (existing && existsSync(existing.filePath)) {
      if (updateArtifactMetadata(existing, channel, versionLabel, buildNumber)) persistIndex();
      return existing;
    }
    const file = await stat(migratedPath);
    index.artifacts = index.artifacts.filter((artifact) => artifact.key !== key || existsSync(artifact.filePath));
    const now = Date.now();
    const record: ArtifactRecord = {
      id: randomUUID(),
      key,
      bundleId: job.bundleId,
      channel,
      externalVersionId: job.externalVersionId,
      testflightBuildId: job.testflight?.build.id,
      versionLabel: normalizeArtifactVersionLabel(versionLabel, channel),
      buildNumber: buildNumber?.trim() || undefined,
      filePath: migratedPath,
      fileSizeBytes: file.size,
      sha256: await sha256File(migratedPath),
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceJobId: job.id,
    };
    index.artifacts.push(record);
    persistIndex();
    return record;
  });
}

export async function reconcileArtifactStore(): Promise<void> {
  await withMutation(async () => {
    await mkdir(stagingDir, { recursive: true });
    for (const name of await readdir(stagingDir)) await rm(path.join(stagingDir, name), { force: true });

    const normalized: ArtifactRecord[] = [];
    for (const artifact of index.artifacts) {
      const migrated = migrateLegacyPath(artifact.filePath);
      if (!migrated) continue;
      artifact.filePath = migrated;
      artifact.fileSizeBytes = (await stat(migrated)).size;
      normalized.push(artifact);
    }
    index.artifacts = normalized;

    const indexedPaths = new Set(index.artifacts.map((artifact) => path.resolve(artifact.filePath)));
    for (const name of await readdir(config.artifactDir)) {
      if (!name.endsWith('.ipa')) continue;
      const candidate = path.resolve(config.artifactDir, name);
      if (!indexedPaths.has(candidate)) {
        await rm(candidate, { force: true });
        log.warn('removed unindexed IPA from artifact storage', { path: candidate });
      }
    }

    const stats = getArtifactStorageStats();
    if (stats.usedBytes > config.artifactMaxBytes) {
      const previousArtifacts = index.artifacts;
      const evictedArtifacts = artifactsToEvict(0, new Set());
      const evictedIds = new Set(evictedArtifacts.map((artifact) => artifact.id));
      index.artifacts = previousArtifacts.filter((artifact) => !evictedIds.has(artifact.id));
      try {
        persistIndex();
      } catch (error) {
        index.artifacts = previousArtifacts;
        throw error;
      }
      for (const evicted of evictedArtifacts) {
        try {
          await rm(evicted.filePath, { force: true });
          log.info('evicted artifact for storage quota', { artifactId: evicted.id, bundleId: evicted.bundleId, sizeBytes: evicted.fileSizeBytes });
        } catch (error) {
          log.warn('failed to remove an evicted artifact file', { artifactId: evicted.id, path: evicted.filePath, error: String(error) });
        }
      }
    } else {
      persistIndex();
    }
  });
}

export async function initializeArtifactStore(jobs: Array<{
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
  ipaMetadata?: { shortVersion?: string; bundleVersion?: string };
  filePath?: string;
  fileSizeBytes?: number;
  artifactId?: string;
}>): Promise<void> {
  for (const job of jobs) {
    if (!job.filePath) continue;
    const artifact = await registerLegacyJobArtifact(job);
    if (artifact) {
      job.artifactId = artifact.id;
      job.filePath = artifact.filePath;
      job.fileSizeBytes = artifact.fileSizeBytes;
    }
  }
  await reconcileArtifactStore();
}

export function getArtifactForJob(job: { artifactId?: string; filePath?: string }): ArtifactRecord | undefined {
  if (job.artifactId) return getArtifactById(job.artifactId);
  return index.artifacts.find((artifact) => artifact.filePath === job.filePath);
}

export function artifactDownloadName(artifact: ArtifactRecord): string {
  const version = artifact.versionLabel ? `-${artifact.versionLabel.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  return `${artifact.bundleId}${version}.ipa`;
}

export function buildArtifactFileUrl(id: string): string {
  return `${config.publicBaseUrl}/v1/artifacts/${encodeURIComponent(id)}/file`;
}

export function buildDashboardArtifactFileUrl(id: string): string {
  return `${config.publicBaseUrl}/v1/dashboard/artifacts/${encodeURIComponent(id)}/file`;
}
