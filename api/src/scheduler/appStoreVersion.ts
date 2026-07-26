import { compareVersions } from '#util/version.js';
import type { AppVersionEntry } from '#versions.js';

export function selectAppStoreVersion(entries: AppVersionEntry[], targetVersion: string): AppVersionEntry | undefined {
  return entries
    .filter((entry) => entry.displayVersion && compareVersions(entry.displayVersion, targetVersion) === 0)
    .sort((a, b) => Number(b.externalVersionId) - Number(a.externalVersionId))[0];
}
