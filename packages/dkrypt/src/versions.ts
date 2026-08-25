import { scopedLogger } from '#logger.js';
import { lookupCurrentVersion } from '#scheduler/itunes.js';
import { compareVersions } from '#util/version.js';

const log = scopedLogger('versions');

export interface AppVersionEntry {
  /** App Store external version id when the catalog exposes one. */
  externalVersionId?: string;
  isLatest: boolean;
  displayVersion?: string;
  bundleVersion?: string;
  releaseDate?: string;
}

interface CommunityVersionInfo {
  displayVersion: string;
  releaseDate?: string;
}

interface CommunityVersionRecord {
  bundle_version?: string;
  external_identifier?: number | string;
  created_at?: string;
}

const COMMUNITY_LOOKUP_TIMEOUT_MS = 6_000;

/**
 * The signed-in App Store account is driven by the autoinstall bridge. The
 * bridge installs the current App Store item without requiring an external
 * version id, so the current lookup is metadata only; ipadecrypt is not
 * involved in version discovery.
 */
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
  const current = await lookupCurrentVersion(bundleId);
  const community = await fetchCommunityVersionLabels(current.trackId);

  // The community history is useful for pinned historical releases, but the
  // current version is always taken from the current App Store lookup. When
  // the history service has not observed the current release yet, the
  // current entry intentionally has no external id and is installed through
  // autoinstall's unpinned App Store transaction.
  const currentHistoryEntry = [...community.entries()]
    .filter(([, entry]) => compareVersions(entry.displayVersion, current.version) === 0)
    .sort(([a], [b]) => Number(b) - Number(a))[0];

  const entries: AppVersionEntry[] = [
    {
      externalVersionId: currentHistoryEntry?.[0],
      isLatest: true,
      displayVersion: current.version,
    },
  ];

  for (const [externalVersionId, entry] of community.entries()) {
    if (externalVersionId === currentHistoryEntry?.[0]) continue;
    entries.push({ externalVersionId, isLatest: false, displayVersion: entry.displayVersion, releaseDate: entry.releaseDate });
  }

  return entries;
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
