import { artifactKeyForTestFlight, getArtifactByKey } from '#artifacts.js';
import { minimumOsVersionForBuild } from '#jobs/deviceDispatch.js';
import type { DeviceRecord } from '#store/state.js';
import { compareVersions } from '#util/version.js';
import { listBuilds, listTestFlightApps, listTrains, type TFBuild, type TFDeviceApp, type TFTrain } from '#testflight.js';
import type { TestFlightCatalogApp } from '#testflightSubscriptions.js';
import { isTestFlightVerificationFresh } from '#testflightPolicy.js';

export interface TestFlightSmokeCandidate {
  appId: number;
  trainVersion: string;
  build: TFBuild;
}

export interface TestFlightSmokeServices {
  listApps(device: DeviceRecord, refreshCatalog: boolean): Promise<TFDeviceApp[]>;
  listTrains(appId: number, device: DeviceRecord): Promise<TFTrain[]>;
  listBuilds(appId: number, trainVersion: string, device: DeviceRecord): Promise<TFBuild[]>;
  hasCachedArtifact(bundleId: string, buildId: number): boolean;
}

export interface TestFlightSmokeCatalogState {
  apps: readonly Pick<TestFlightCatalogApp, 'bundleId' | 'devices'>[];
  fetchedAt?: number;
  refreshing?: boolean;
}

export interface TestFlightSmokeVerificationServices {
  readCatalog(): Promise<TestFlightSmokeCatalogState>;
  refreshCatalog(): Promise<void>;
  now?(): number;
  wait?(milliseconds: number): Promise<void>;
}

export function isTestFlightSmokeDeviceVerified(
  apps: TestFlightSmokeCatalogState['apps'],
  bundleId: string,
  deviceId: string,
  now = Date.now(),
): boolean {
  return apps.some((app) => app.bundleId === bundleId && app.devices.some((device) =>
    device.id === deviceId
      && typeof device.verifiedAt === 'number'
      && isTestFlightVerificationFresh(device.verifiedAt, now),
  ));
}

export async function waitForTestFlightSmokeDeviceVerification(
  bundleId: string,
  deviceId: string,
  services: TestFlightSmokeVerificationServices,
  timeoutMs = 90_000,
): Promise<void> {
  const now = services.now ?? Date.now;
  const wait = services.wait ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let catalog = await services.readCatalog();
  if (isTestFlightSmokeDeviceVerified(catalog.apps, bundleId, deviceId, now())) return;

  let observedFetchedAt = catalog.fetchedAt;
  let refreshNeedsRetry = false;
  await services.refreshCatalog();
  const deadline = now() + timeoutMs;
  let nextRefreshAt = now() + 5_000;
  while (now() < deadline) {
    catalog = await services.readCatalog();
    if (isTestFlightSmokeDeviceVerified(catalog.apps, bundleId, deviceId, now())) return;

    if (catalog.refreshing !== true && catalog.fetchedAt !== undefined && catalog.fetchedAt !== observedFetchedAt) {
      observedFetchedAt = catalog.fetchedAt;
      refreshNeedsRetry = true;
    }
    if (refreshNeedsRetry && now() >= nextRefreshAt) {
      await services.refreshCatalog();
      refreshNeedsRetry = false;
      nextRefreshAt = now() + 5_000;
    }
    await wait(1_000);
  }
  throw new Error(`TestFlight access verification did not refresh for ${bundleId} on device ${deviceId} within ${timeoutMs / 1_000} seconds`);
}

const defaultServices: TestFlightSmokeServices = {
  listApps: listTestFlightApps,
  listTrains,
  listBuilds,
  hasCachedArtifact: (bundleId, buildId) => Boolean(getArtifactByKey(artifactKeyForTestFlight(bundleId, buildId))),
};

export async function listTestFlightSmokeCandidates(
  bundleId: string,
  device: DeviceRecord,
  now = Date.now(),
  services: TestFlightSmokeServices = defaultServices,
): Promise<TestFlightSmokeCandidate[]> {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)) throw new Error('invalid TestFlight smoke bundle identifier');
  const app = (await services.listApps(device, true)).find((candidate) => candidate.bundleId === bundleId);
  if (!app) throw new Error(`TestFlight app ${bundleId} is not visible in the device catalog`);

  const trains = await services.listTrains(app.appId, device);
  const candidates: TestFlightSmokeCandidate[] = [];
  for (const train of trains) {
    const builds = await services.listBuilds(app.appId, train.trainVersion, device);
    for (const build of builds) {
      if (build.bundleId !== bundleId || services.hasCachedArtifact(bundleId, build.id)) continue;
      const minimumOsVersion = minimumOsVersionForBuild(build);
      const deviceOsVersion = device.iosVersion?.trim();
      if (minimumOsVersion && (!deviceOsVersion || !/^\d+(?:\.\d+){0,3}$/.test(deviceOsVersion) || compareVersions(deviceOsVersion, minimumOsVersion) < 0)) continue;
      if (build.expiration) {
        const expiresAt = Date.parse(build.expiration);
        if (!Number.isFinite(expiresAt) || expiresAt <= now) continue;
      }
      candidates.push({ appId: app.appId, trainVersion: train.trainVersion, build });
    }
  }

  return candidates.sort((left, right) =>
    compareVersions(right.trainVersion, left.trainVersion)
      || compareVersions(right.build.cfBundleVersion, left.build.cfBundleVersion)
      || right.build.id - left.build.id,
  );
}
