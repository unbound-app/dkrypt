import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';

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
}

export interface ArtifactListResult {
  artifacts: ArtifactRecord[];
  total: number;
  totalBytes: number;
  maxBytes: number;
}

interface ArtifactIndex {
  version: 1;
  artifacts: ArtifactRecord[];
}

const indexPath = path.join(config.stateDir, 'artifacts.json');
const stagingDir = path.join(config.artifactDir, '.staging');
let index: ArtifactIndex = loadIndex();
let mutationChain = Promise.resolve();

function loadIndex(): ArtifactIndex {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(indexPath)) return { version: 1, artifacts: [] };
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as Partial<ArtifactIndex>;
    if (parsed.version !== 1 || !Array.isArray(parsed.artifacts)) throw new Error('unsupported artifact index');
    return { version: 1, artifacts: parsed.artifacts.filter(isArtifactRecord) };
  } catch (err) {
    log.warn('failed to load artifact index; starting with an empty index', { error: String(err) });
    return { version: 1, artifacts: [] };
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
  const temporary = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(index));
  renameSync(temporary, indexPath);
}

function withMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationChain.then(fn, fn);
  mutationChain = next.then(() => undefined, () => undefined);
  return next;
}

export function artifactKeyForAppStore(bundleId: string, externalVersionId: string): string {
  return `${bundleId}|appstore|${externalVersionId}`;
}

export function artifactKeyForTestFlight(bundleId: string, buildId: number): string {
  return `${bundleId}|testflight|${buildId}`;
}

export function artifactKeyForJob(job: {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number } };
}): string {
  if (job.testflight) return artifactKeyForTestFlight(job.bundleId, job.testflight.build.id);
  if (job.externalVersionId) return artifactKeyForAppStore(job.bundleId, job.externalVersionId);
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

export function getArtifactByKey(key: string): ArtifactRecord | undefined {
  const artifact = index.artifacts.find((candidate) => candidate.key === key);
  if (!artifact || !existsSync(artifact.filePath)) return undefined;
  return artifact;
}

export function artifactFileAvailable(artifact: ArtifactRecord | undefined): boolean {
  return !!artifact && existsSync(artifact.filePath);
}

export function getArtifactStorageStats(): { usedBytes: number; maxBytes: number; count: number } {
  const available = index.artifacts.filter((artifact) => existsSync(artifact.filePath));
  return {
    usedBytes: available.reduce((total, artifact) => total + artifact.fileSizeBytes, 0),
    maxBytes: config.artifactMaxBytes,
    count: available.length,
  };
}

export function listArtifacts(options: ArtifactListOptions = {}): ArtifactListResult {
  const query = options.query?.trim().toLowerCase();
  const filtered = index.artifacts
    .filter((artifact) => artifactFileAvailable(artifact))
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
  const stats = getArtifactStorageStats();
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

async function evictForBytes(requiredBytes: number, protectedKeys: Set<string>): Promise<void> {
  let usedBytes = getArtifactStorageStats().usedBytes;
  if (requiredBytes > config.artifactMaxBytes) {
    throw new Error(`artifact is ${requiredBytes} bytes, larger than the ${config.artifactMaxBytes}-byte storage limit`);
  }

  const candidates = index.artifacts
    .filter((artifact) => !protectedKeys.has(artifact.key))
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.createdAt - b.createdAt);

  for (const candidate of candidates) {
    if (usedBytes + requiredBytes <= config.artifactMaxBytes) break;
    const size = existsSync(candidate.filePath) ? candidate.fileSizeBytes : 0;
    await rm(candidate.filePath, { force: true });
    index.artifacts = index.artifacts.filter((artifact) => artifact.id !== candidate.id);
    usedBytes -= size;
    log.info('evicted retained artifact for storage quota', { artifactId: candidate.id, bundleId: candidate.bundleId, sizeBytes: size });
  }

  if (usedBytes + requiredBytes > config.artifactMaxBytes) {
    throw new Error('unable to free enough retained artifact storage');
  }
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
}): Promise<ArtifactRecord> {
  return withMutation(async () => {
    await mkdir(config.artifactDir, { recursive: true });
    const existing = getArtifactByKey(input.key);
    if (existing) {
      await rm(input.stagingPath, { force: true });
      touchArtifactUnsafe(existing);
      return existing;
    }

    const file = await stat(input.stagingPath);
    const sha256 = await sha256File(input.stagingPath);
    index.artifacts = index.artifacts.filter((artifact) => artifact.key !== input.key || existsSync(artifact.filePath));
    await evictForBytes(file.size, new Set([input.key]));
    const now = Date.now();
    const artifact: ArtifactRecord = {
      id: randomUUID(),
      key: input.key,
      bundleId: input.bundleId,
      channel: input.channel,
      externalVersionId: input.externalVersionId,
      testflightBuildId: input.testflightBuildId,
      versionLabel: input.versionLabel,
      buildNumber: input.buildNumber,
      filePath: path.join(config.artifactDir, `${now}-${randomUUID()}.ipa`),
      fileSizeBytes: file.size,
      sha256,
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      sourceJobId: input.sourceJobId,
    };
    await rename(input.stagingPath, artifact.filePath);
    index.artifacts.push(artifact);
    persistIndex();
    return artifact;
  });
}

export async function registerLegacyJobArtifact(job: {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
  filePath?: string;
  fileSizeBytes?: number;
}): Promise<ArtifactRecord | undefined> {
  const migratedPath = migrateLegacyPath(job.filePath);
  if (!migratedPath) return undefined;
  return withMutation(async () => {
    const key = artifactKeyForJob(job);
    const existing = getArtifactByKey(key);
    if (existing && existsSync(existing.filePath)) return existing;
    const file = await stat(migratedPath);
    index.artifacts = index.artifacts.filter((artifact) => artifact.key !== key || existsSync(artifact.filePath));
    const now = Date.now();
    const record: ArtifactRecord = {
      id: randomUUID(),
      key,
      bundleId: job.bundleId,
      channel: job.testflight ? 'testflight' : 'appstore',
      externalVersionId: job.externalVersionId,
      testflightBuildId: job.testflight?.build.id,
      versionLabel: job.versionLabel,
      buildNumber: job.testflight?.build.cfBundleVersion,
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
    if (stats.usedBytes > config.artifactMaxBytes) await evictForBytes(0, new Set());
    persistIndex();
  });
}

export async function initializeArtifactStore(jobs: Array<{
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: { build: { id: number; cfBundleShortVersion: string; cfBundleVersion: string } };
  versionLabel?: string;
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
