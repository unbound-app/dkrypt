import type { AppWatch } from '#store/state.js';
import type { TFBuild, TFTrain } from '#testflight.js';
import { classifySchedulerFailure } from '#scheduler/failure.js';
import type { JobFailureClass } from '#util/failureCategory.js';

export interface TestFlightUpdateCheck {
  ok: boolean;
  appId?: number;
  latestTag?: string;
  build?: TFBuild;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
  failureClass?: JobFailureClass;
  retryable?: boolean;
}

type TestFlightWatch = Pick<AppWatch, 'bundleId' | 'repo' | 'testFlightPolicy' | 'testFlightTrain'>;

interface TestFlightUpdateServices {
  lookupCurrentVersion: (bundleId: string) => Promise<{ trackId: number }>;
  listTrains: (appId: number) => Promise<TFTrain[]>;
  listBuilds: (appId: number, trainVersion: string) => Promise<TFBuild[]>;
  releaseTagExists: (repo: string, tag: string) => Promise<boolean>;
}

function trainMatchesPolicy(trainVersion: string, watch: TestFlightWatch): boolean {
  return watch.testFlightPolicy !== 'train' || trainVersion === watch.testFlightTrain;
}

function isExpiredBuild(build: TFBuild): boolean {
  return Boolean(build.expiration && Number.isFinite(Date.parse(build.expiration)) && Date.parse(build.expiration) <= Date.now());
}

function failedCheck(reason: string, error: unknown, details: Pick<TestFlightUpdateCheck, 'appId' | 'latestTag' | 'build'> = {}): TestFlightUpdateCheck {
  return {
    ...details,
    ...classifySchedulerFailure(error),
    ok: false,
    wouldDispatch: false,
    reason,
  };
}

export async function checkForTestFlightUpdate(
  watch: TestFlightWatch,
  services: TestFlightUpdateServices,
): Promise<TestFlightUpdateCheck> {
  if (!watch.bundleId) {
    return { ok: true, wouldDispatch: false, reason: 'No watch bundle ID configured' };
  }

  let appId: number;
  try {
    appId = (await services.lookupCurrentVersion(watch.bundleId)).trackId;
  } catch (error) {
    return failedCheck(`iTunes lookup failed: ${String(error)}`, error);
  }

  let trains: TFTrain[];
  try {
    trains = await services.listTrains(appId);
  } catch (error) {
    return failedCheck(`TestFlight trains lookup failed: ${String(error)}`, error, { appId });
  }

  const eligibleTrains = trains.filter((train) => trainMatchesPolicy(train.trainVersion, watch));
  if (eligibleTrains.length === 0) {
    return { ok: true, appId, wouldDispatch: false, reason: 'No TestFlight trains matched this watch policy' };
  }

  let latestBuild: TFBuild | undefined;
  for (const train of eligibleTrains) {
    let builds: TFBuild[];
    try {
      builds = await services.listBuilds(appId, train.trainVersion);
    } catch (error) {
      return failedCheck(
        `TestFlight builds lookup failed for train ${train.trainVersion}: ${String(error)}`,
        error,
        { appId },
      );
    }

    for (const build of builds) {
      if (watch.testFlightPolicy === 'latestNonExpired' && isExpiredBuild(build)) continue;
      const buildNumber = Number.parseInt(build.cfBundleVersion, 10) || 0;
      const latestBuildNumber = latestBuild ? Number.parseInt(latestBuild.cfBundleVersion, 10) || 0 : -1;
      if (buildNumber > latestBuildNumber) latestBuild = build;
    }
  }

  if (!latestBuild) {
    return { ok: true, appId, wouldDispatch: false, reason: 'No TestFlight builds found' };
  }

  const latestTag = `v${latestBuild.cfBundleShortVersion}_${latestBuild.cfBundleVersion}`;
  let alreadyReleased: boolean;
  try {
    alreadyReleased = await services.releaseTagExists(watch.repo, latestTag);
  } catch (error) {
    return failedCheck(`Failed to verify releases: ${String(error)}`, error, { appId, latestTag, build: latestBuild });
  }

  if (alreadyReleased) {
    return {
      ok: true,
      appId,
      latestTag,
      build: latestBuild,
      alreadyReleased: true,
      wouldDispatch: false,
      reason: `${latestTag} already released`,
    };
  }

  return {
    ok: true,
    appId,
    latestTag,
    build: latestBuild,
    alreadyReleased: false,
    wouldDispatch: true,
    reason: `${latestTag} not yet released - would dispatch`,
  };
}
