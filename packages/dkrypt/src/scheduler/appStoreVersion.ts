import { compareVersions } from '#util/version.js';
import type { AppVersionEntry } from '#versions.js';

export interface AppStoreDecryptTarget {
  expectedVersion: string;
  externalVersionId?: string;
  minimumOsVersion?: string;
}

export function selectAppStoreVersion(entries: AppVersionEntry[], targetVersion: string): AppVersionEntry | undefined {
  return entries
    .filter((entry) => entry.displayVersion && compareVersions(entry.displayVersion, targetVersion) === 0)
    .sort((a, b) => Number(b.externalVersionId) - Number(a.externalVersionId))[0];
}

export function resolveAppStoreDecryptTarget(entries: AppVersionEntry[], expectedVersion: string): AppStoreDecryptTarget {
  const selected = selectAppStoreVersion(entries, expectedVersion);
  const target: AppStoreDecryptTarget = { expectedVersion };
  if (selected?.externalVersionId) target.externalVersionId = selected.externalVersionId;
  if (selected?.minimumOsVersion) target.minimumOsVersion = selected.minimumOsVersion;
  return target;
}
