import cron from 'node-cron';
import { config } from '../config.js';
import type { Job } from '../jobs/types.js';
import { enqueueDecryptJob, reclaimJobFile, waitForJob } from '../jobs/store.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('scheduler');
import { notify } from '../notify.js';
import { getEffectiveSettings, isSchedulerEnabled, recordSchedulerRun, type SchedulerSettings } from '../store/state.js';
import type { TFBuild } from '../testflight.js';
import { listBuilds, listTrains } from '../testflight.js';
import { buildSignedFileUrl } from '../util/signedUrl.js';
import { compareVersions, normalizeVersion } from '../util/version.js';
import { dispatchIpaUpdate, findDispatchedRun, getRun, listReleaseTagNames, listReleaseVersions } from './github.js';
import { lookupCurrentVersion } from './itunes.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCHEDULER_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface UpdateCheck {
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export async function checkForUpdate(settings: SchedulerSettings): Promise<UpdateCheck> {
  let itunesVersion: string;
  try {
    itunesVersion = (await lookupCurrentVersion(settings.watchBundleId)).version;
  } catch (err) {
    return { wouldDispatch: false, reason: `iTunes lookup failed: ${String(err)}` };
  }

  const normalizedVersion = normalizeVersion(itunesVersion);

  let releaseVersions: Set<string>;
  try {
    releaseVersions = await listReleaseVersions(settings.watchAppRepo);
  } catch (err) {
    return { itunesVersion, normalizedVersion, wouldDispatch: false, reason: `failed to list releases: ${String(err)}` };
  }

  const alreadyReleased = [...releaseVersions].some((v) => compareVersions(v, normalizedVersion) === 0);
  if (alreadyReleased) {
    return {
      itunesVersion,
      normalizedVersion,
      alreadyReleased: true,
      wouldDispatch: false,
      reason: `iTunes version ${normalizedVersion} already has a matching release`,
    };
  }

  return {
    itunesVersion,
    normalizedVersion,
    alreadyReleased: false,
    wouldDispatch: true,
    reason: `no release matches iTunes version ${normalizedVersion} - would decrypt and dispatch`,
  };
}

export interface TestFlightUpdateCheck {
  appId?: number;
  latestTag?: string;
  build?: TFBuild;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export async function checkForTestFlightUpdate(settings: SchedulerSettings): Promise<TestFlightUpdateCheck> {
  if (!settings.watchBundleId) {
    return { wouldDispatch: false, reason: 'no watch bundle ID configured' };
  }

  let appId: number;
  try {
    appId = (await lookupCurrentVersion(settings.watchBundleId)).trackId;
  } catch (err) {
    return { wouldDispatch: false, reason: `iTunes lookup failed: ${String(err)}` };
  }

  let trains: Awaited<ReturnType<typeof listTrains>>;
  try {
    trains = await listTrains(appId);
  } catch (err) {
    return { appId, wouldDispatch: false, reason: `TestFlight trains lookup failed: ${String(err)}` };
  }

  let latestBuild: TFBuild | undefined;
  for (const train of trains) {
    let builds: TFBuild[];
    try {
      builds = await listBuilds(appId, train.trainVersion);
    } catch (err) {
      log.error('failed to list TestFlight builds for train', { appId, trainVersion: train.trainVersion, error: String(err) });
      continue;
    }
    for (const build of builds) {
      const buildNum = Number.parseInt(build.cfBundleVersion, 10) || 0;
      const latestNum = latestBuild ? Number.parseInt(latestBuild.cfBundleVersion, 10) || 0 : -1;
      if (buildNum > latestNum) latestBuild = build;
    }
  }

  if (!latestBuild) {
    return { appId, wouldDispatch: false, reason: 'no TestFlight builds found for this app' };
  }

  const latestTag = `v${latestBuild.cfBundleShortVersion}_${latestBuild.cfBundleVersion}`;

  let tagNames: Set<string>;
  try {
    tagNames = await listReleaseTagNames(settings.watchAppRepo);
  } catch (err) {
    return { appId, latestTag, build: latestBuild, wouldDispatch: false, reason: `failed to list releases: ${String(err)}` };
  }

  if (tagNames.has(latestTag)) {
    return {
      appId,
      latestTag,
      build: latestBuild,
      alreadyReleased: true,
      wouldDispatch: false,
      reason: `TestFlight build ${latestTag} already has a matching release`,
    };
  }

  return {
    appId,
    latestTag,
    build: latestBuild,
    alreadyReleased: false,
    wouldDispatch: true,
    reason: `no release matches TestFlight build ${latestTag} - would install, decrypt and dispatch`,
  };
}

async function pollRunToCompletion(dispatchRepo: string, workflowFile: string, dispatchedAt: Date): Promise<void> {
  const deadline = Date.now() + config.runPollTimeoutMinutes * 60_000;

  let runId: number | undefined;
  while (Date.now() < deadline && runId === undefined) {
    const run = await findDispatchedRun(dispatchRepo, workflowFile, dispatchedAt);
    if (run) {
      runId = run.id;
      break;
    }
    await sleep(config.runPollIntervalSeconds * 1000);
  }

  if (runId === undefined) {
    log.warn('gave up waiting for the dispatched workflow run to appear', { dispatchRepo, workflowFile });
    return;
  }

  while (Date.now() < deadline) {
    const run = await getRun(dispatchRepo, runId);
    if (run.status === 'completed') {
      log.info('dispatched workflow run completed', { runId, conclusion: run.conclusion });
      return;
    }
    await sleep(config.runPollIntervalSeconds * 1000);
  }

  log.warn('dispatched workflow run did not complete before timeout', { runId });
}

async function decryptAndDispatch(
  job: Job,
  settings: SchedulerSettings,
  isTestflight: boolean,
  versionLabel: string,
): Promise<void> {
  const finished = await waitForJob(job, SCHEDULER_JOB_TIMEOUT_MS);

  if (finished.status !== 'done') {
    log.error('scheduled decrypt did not complete successfully', {
      bundleId: settings.watchBundleId,
      isTestflight,
      status: finished.status,
      error: finished.error,
    });
    return;
  }

  try {
    const ipaUrl = buildSignedFileUrl(finished.id, config.fileTtlMinutes);
    const dispatchedAt = new Date();
    await dispatchIpaUpdate(settings.ghDispatchRepo, ipaUrl, isTestflight);
    log.info('dispatched ipa-update', { dispatchRepo: settings.ghDispatchRepo, bundleId: settings.watchBundleId, isTestflight });

    await pollRunToCompletion(settings.ghDispatchRepo, settings.ghWorkflowFile, dispatchedAt);
    const source = isTestflight ? 'TestFlight' : 'App Store';
    await notify(`✅ dkrypt: **${settings.watchBundleId}** ${versionLabel} (${source}) decrypted and dispatched to \`${settings.ghDispatchRepo}\`.`);
  } catch (err) {
    log.error('dispatch/poll failed', { error: String(err), isTestflight });
    await notify(`⚠️ dkrypt: dispatch/poll failed for **${settings.watchBundleId}** ${versionLabel}: ${String(err)}`);
  } finally {
    await reclaimJobFile(finished);
  }
}

async function tickAppStore(settings: SchedulerSettings): Promise<void> {
  const check = await checkForUpdate(settings);
  if (!check.wouldDispatch) {
    if (check.alreadyReleased) {
      log.info('itunes version already has a matching release, nothing to do', {
        bundleId: settings.watchBundleId,
        version: check.normalizedVersion,
      });
    } else {
      log.error(check.reason, { bundleId: settings.watchBundleId });
    }
    return;
  }

  const normalized = check.normalizedVersion as string;
  log.info('no matching release found, decrypting', { bundleId: settings.watchBundleId, version: normalized });

  const job = enqueueDecryptJob(settings.watchBundleId, 'scheduler');
  await decryptAndDispatch(job, settings, false, `v${normalized}`);
}

async function tickTestFlight(settings: SchedulerSettings): Promise<void> {
  const check = await checkForTestFlightUpdate(settings);
  if (!check.wouldDispatch || !check.build) {
    if (check.alreadyReleased) {
      log.info('TestFlight build already has a matching release, nothing to do', {
        bundleId: settings.watchBundleId,
        tag: check.latestTag,
      });
    } else {
      log.error(check.reason, { bundleId: settings.watchBundleId });
    }
    return;
  }

  log.info('no matching release found for latest TestFlight build, installing and decrypting', {
    bundleId: settings.watchBundleId,
    tag: check.latestTag,
  });

  const job = enqueueDecryptJob(settings.watchBundleId, 'scheduler', undefined, { appId: check.appId as number, build: check.build });
  await decryptAndDispatch(job, settings, true, check.latestTag as string);
}

async function tick(): Promise<void> {
  recordSchedulerRun();
  const settings = getEffectiveSettings();
  log.info('scheduler tick', { bundleId: settings.watchBundleId, appRepo: settings.watchAppRepo });

  await tickAppStore(settings);
  await tickTestFlight(settings);
}

let currentTask: cron.ScheduledTask | undefined;
let currentCronExpr: string | undefined;

export function applySchedule(): void {
  if (!isSchedulerEnabled()) {
    if (currentTask) {
      currentTask.stop();
      currentTask = undefined;
      currentCronExpr = undefined;
    }
    log.info('scheduler disabled: set a watch bundle ID, app repo, dispatch repo and GH_TOKEN to enable it');
    return;
  }

  const settings = getEffectiveSettings();
  if (currentCronExpr === settings.pollCron && currentTask) return;

  if (currentTask) currentTask.stop();

  currentCronExpr = settings.pollCron;
  currentTask = cron.schedule(settings.pollCron, () => {
    void tick().catch((err) => log.error('scheduler tick threw', { error: String(err) }));
  });

  log.info('scheduler (re)scheduled', {
    cron: settings.pollCron,
    bundleId: settings.watchBundleId,
    appRepo: settings.watchAppRepo,
  });
}

export function startScheduler(): void {
  applySchedule();
}
