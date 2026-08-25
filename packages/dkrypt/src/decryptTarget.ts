import { lookupAppMetadata } from '#scheduler/itunes.js';
import { listAppVersions, type AppVersionEntry } from '#versions.js';
import { compareVersions } from '#util/version.js';
import { listBuilds, listTrains, type TFBuild } from '#testflight.js';
import { artifactKeyForAppStoreVersion, artifactKeyForTestFlight } from '#artifacts.js';

export const VERSION_SELECTOR_RE = /^v?\d+(?:\.\d+)*(?:_\d+)?$/i;

export interface ResolvedDecryptTarget {
  bundleId: string;
  selector?: string;
  channel: 'appstore' | 'testflight';
  externalVersionId?: string;
  testflight?: { appId: number; build: TFBuild };
  versionLabel: string;
  artifactKey: string;
}

export function normalizeVersionSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim();
  if (!trimmed) return undefined;
  const normalized = trimmed.replace(/^v/i, '');
  if (!VERSION_SELECTOR_RE.test(trimmed)) {
    throw new Error('version must match a release tag such as 240, 234.2, or 240_109440');
  }
  return normalized;
}

function selectVersion(entries: AppVersionEntry[], requested: string | undefined): AppVersionEntry | undefined {
  if (!requested) return entries.find((entry) => entry.isLatest) ?? entries[0];
  return entries
    .filter((entry) => entry.displayVersion && compareVersions(entry.displayVersion, requested) === 0)
    .sort((a, b) => Number(b.externalVersionId) - Number(a.externalVersionId))[0];
}

export async function resolveDecryptTarget(bundleId: string, selector?: string): Promise<ResolvedDecryptTarget> {
  const normalized = normalizeVersionSelector(selector);
  const testFlightMatch = normalized?.match(/^(\d+(?:\.\d+)*)_(\d+)$/);

  if (testFlightMatch) {
    const shortVersion = testFlightMatch[1];
    const buildNumber = testFlightMatch[2];
    const { trackId } = await lookupAppMetadata(bundleId);
    const trains = await listTrains(trackId);
    const train = trains.find((candidate) => compareVersions(candidate.trainVersion, shortVersion) === 0);
    if (!train) throw new Error(`TestFlight train ${shortVersion} was not found for ${bundleId}`);
    const builds = await listBuilds(trackId, train.trainVersion);
    const build = builds.find((candidate) => candidate.cfBundleVersion === buildNumber && candidate.bundleId === bundleId);
    if (!build) throw new Error(`TestFlight build ${shortVersion}_${buildNumber} was not found for ${bundleId}`);
    return {
      bundleId,
      selector: normalized,
      channel: 'testflight',
      testflight: { appId: trackId, build },
      versionLabel: `${build.cfBundleShortVersion}_${build.cfBundleVersion}`,
      artifactKey: artifactKeyForTestFlight(bundleId, build.id),
    };
  }

  const entries = await listAppVersions(bundleId);
  const selected = selectVersion(entries, normalized);
  if (!selected) {
    throw new Error(normalized ? `App Store version ${normalized} was not found for ${bundleId}` : `no latest App Store version was found for ${bundleId}`);
  }
  const versionLabel = selected.displayVersion ?? normalized ?? 'latest';

  return {
    bundleId,
    selector: normalized,
    channel: 'appstore',
    externalVersionId: selected.externalVersionId,
    versionLabel,
    artifactKey: artifactKeyForAppStoreVersion(bundleId, versionLabel, selected.externalVersionId),
  };
}
