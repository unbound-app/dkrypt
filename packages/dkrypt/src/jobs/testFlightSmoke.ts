import { artifactKeyForTestFlight, getArtifactByKey } from '#artifacts.js';
import type { DeviceRecord } from '#store/state.js';
import { compareVersions } from '#util/version.js';
import { listBuilds, listTestFlightApps, listTrains, type TFBuild, type TFDeviceApp, type TFTrain } from '#testflight.js';

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
