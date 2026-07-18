import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { scopedLogger } from './logger.js';
import { lookupCurrentVersion } from './scheduler/itunes.js';

const log = scopedLogger('versions');

const ipadecryptRoot = path.dirname(config.ipadecryptConfigPath);
const versionsLogPath = path.join(ipadecryptRoot, 'logs', 'versions.log');
const versionsCacheDir = path.join(ipadecryptRoot, 'cache', 'versions');

export interface AppVersionEntry {
  externalVersionId: string;
  isLatest: boolean;
  displayVersion?: string;
  bundleVersion?: string;
  releaseDate?: string;
}

interface VersionsLogRecord {
  ts: string;
  kind: string;
  bundleId: string;
  metadata: Record<string, unknown>;
}

interface CachedVersionEntry {
  displayVersion?: string;
  bundleVersion?: string;
  releaseDate?: string;
}

interface VersionsCacheFile {
  bundleId: string;
  versions: Record<string, CachedVersionEntry>;
}

async function readLastListVersionsRecord(bundleId: string): Promise<VersionsLogRecord | undefined> {
  let text: string;
  try {
    text = await readFile(versionsLogPath, 'utf8');
  } catch {
    return undefined;
  }

  let last: VersionsLogRecord | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as VersionsLogRecord;
      if (rec.kind === 'list_versions' && rec.bundleId === bundleId) last = rec;
    } catch {
      // skip malformed lines
    }
  }
  return last;
}

async function readVersionsCache(bundleId: string): Promise<VersionsCacheFile | undefined> {
  try {
    const text = await readFile(path.join(versionsCacheDir, `${bundleId}.json`), 'utf8');
    return JSON.parse(text) as VersionsCacheFile;
  } catch {
    return undefined;
  }
}

function metaStr(meta: Record<string, unknown>, key: string): string | undefined {
  const v = meta[key];
  return typeof v === 'string' ? v : undefined;
}

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;

function runIpadecryptVersions(bundleId: string): Promise<void> {
  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) {
    return Promise.reject(new Error(`refusing to run ipadecrypt versions with unsafe bundleId: ${JSON.stringify(bundleId)}`));
  }

  return new Promise((resolve) => {
    const innerCommand = `${config.ipadecryptBin} versions ${bundleId} --log-responses`;
    const child = spawn('script', ['-qec', innerCommand, '/dev/null'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    let sentEnter = false;
    let sawCompletion = false;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      if (!sentEnter && buf.includes('Enter') && buf.includes('Ctrl-C')) {
        sentEnter = true;
        log.info('ipadecrypt versions: answering one-time consent prompt', { bundleId });
        setTimeout(() => {
          try {
            child.stdin.write('\r');
          } catch {}
        }, 300);
      }
      if (!sawCompletion && /\d+ version\(s\)/.test(buf)) {
        sawCompletion = true;
        setTimeout(finish, 500);
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      log.info('ipadecrypt versions spawn error', { bundleId, error: String(err) });
      finish();
    });
    child.on('close', finish);

    const hardTimeout = setTimeout(finish, 15_000);
  });
}

interface CommunityVersionInfo {
  displayVersion: string;
  releaseDate?: string;
}

interface CommunityVersionRecord {
  bundle_version?: string;
  external_identifier?: number;
  created_at?: string;
}

const COMMUNITY_LOOKUP_TIMEOUT_MS = 6_000;

async function fetchCommunityVersionLabels(trackId: number): Promise<Map<string, CommunityVersionInfo>> {
  const map = new Map<string, CommunityVersionInfo>();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMUNITY_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.timbrd.com/apple/app-version/index.php?id=${trackId}`, { signal: controller.signal });
    if (!res.ok) return map;

    const body = (await res.json()) as CommunityVersionRecord[];
    if (!Array.isArray(body)) return map;

    for (const entry of body) {
      if (entry.external_identifier == null || !entry.bundle_version) continue;
      map.set(String(entry.external_identifier), { displayVersion: entry.bundle_version, releaseDate: entry.created_at });
    }
  } catch (err) {
    log.info('community version history lookup failed, continuing without it', { trackId, error: String(err) });
  } finally {
    clearTimeout(timeout);
  }

  return map;
}

async function fetchAppVersions(bundleId: string): Promise<AppVersionEntry[]> {
  await runIpadecryptVersions(bundleId);

  const record = await readLastListVersionsRecord(bundleId);
  if (!record) {
    throw new Error('no version data came back from ipadecrypt versions - check the container logs for the underlying error (network issue, invalid bundle ID, or App Store lookup failure)');
  }

  const meta = record.metadata;
  const rawIds = Array.isArray(meta.softwareVersionExternalIdentifiers) ? meta.softwareVersionExternalIdentifiers : [];
  const ids = rawIds.map((v) => String(v));
  const latestId = meta.softwareVersionExternalIdentifier != null ? String(meta.softwareVersionExternalIdentifier) : undefined;

  const cache = await readVersionsCache(bundleId);

  let community = new Map<string, CommunityVersionInfo>();
  try {
    const { trackId } = await lookupCurrentVersion(bundleId);
    community = await fetchCommunityVersionLabels(trackId);
  } catch (err) {
    log.info('skipping community version history lookup, trackId resolution failed', { bundleId, error: String(err) });
  }

  return ids
    .slice()
    .reverse()
    .map((id) => {
      const isLatest = id === latestId;
      const cached = cache?.versions[id];
      const communityEntry = community.get(id);
      return {
        externalVersionId: id,
        isLatest,
        displayVersion: (isLatest ? metaStr(meta, 'bundleShortVersionString') : undefined) ?? cached?.displayVersion ?? communityEntry?.displayVersion,
        bundleVersion: (isLatest ? metaStr(meta, 'bundleVersion') : undefined) ?? cached?.bundleVersion,
        releaseDate: (isLatest ? metaStr(meta, 'releaseDate') : undefined) ?? cached?.releaseDate ?? communityEntry?.releaseDate,
      };
    });
}

const CACHE_TTL_MS = 5 * 60_000;
const resultCache = new Map<string, { at: number; entries: AppVersionEntry[] }>();
const inFlight = new Map<string, Promise<AppVersionEntry[]>>();

export function listAppVersions(bundleId: string, force = false): Promise<AppVersionEntry[]> {
  const cached = resultCache.get(bundleId);
  if (!force && cached && Date.now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.entries);

  const existing = inFlight.get(bundleId);
  if (existing) return existing;

  const promise = fetchAppVersions(bundleId)
    .then((entries) => {
      resultCache.set(bundleId, { at: Date.now(), entries });
      return entries;
    })
    .finally(() => inFlight.delete(bundleId));

  inFlight.set(bundleId, promise);
  return promise;
}
