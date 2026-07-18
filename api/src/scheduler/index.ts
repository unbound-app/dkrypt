import cron from 'node-cron';
import { config } from '../config.js';
import { emitJobsChanged } from '../events.js';
import type { Job } from '../jobs/types.js';
import { enqueueDecryptJob, reclaimJobFile, waitForJob } from '../jobs/store.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('scheduler');
import { EMBED_COLOR, notify } from '../notify.js';
import {
  type AppWatch,
  getEffectiveSettings,
  getEffectiveWatches,
  isWatchSchedulable,
  recordSchedulerRun,
  recordSchedulerRunOutcome,
  type SchedulerRunOutcome,
  type SchedulerSettings,
  updateSchedulerRunOutcome,
} from '../store/state.js';
import type { TFBuild } from '../testflight.js';
import { listBuilds, listTrains } from '../testflight.js';
import { buildSignedFileUrl } from '../util/signedUrl.js';
import { compareVersions, normalizeVersion } from '../util/version.js';
import { dispatchIpaUpdate, findDispatchedRun, getRun, listReleaseTagNames, listReleaseVersions, type WorkflowRun } from './github.js';
import { lookupCurrentVersion } from './itunes.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SCHEDULER_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface UpdateCheck {
  ok: boolean;
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export async function checkForUpdate(watch: AppWatch): Promise<UpdateCheck> {
  let itunesVersion: string;
  try {
    itunesVersion = (await lookupCurrentVersion(watch.bundleId)).version;
  } catch (err) {
    return { ok: false, wouldDispatch: false, reason: `iTunes lookup failed: ${String(err)}` };
  }

  const normalizedVersion = normalizeVersion(itunesVersion);

  let releaseVersions: Set<string>;
  try {
    releaseVersions = await listReleaseVersions(watch.repo);
  } catch (err) {
    return { ok: false, itunesVersion, normalizedVersion, wouldDispatch: false, reason: `Failed to list releases: ${String(err)}` };
  }

  const alreadyReleased = [...releaseVersions].some((v) => compareVersions(v, normalizedVersion) === 0);
  if (alreadyReleased) {
    return {
      ok: true,
      itunesVersion,
      normalizedVersion,
      alreadyReleased: true,
      wouldDispatch: false,
      reason: `${normalizedVersion} already released`,
    };
  }

  return {
    ok: true,
    itunesVersion,
    normalizedVersion,
    alreadyReleased: false,
    wouldDispatch: true,
    reason: `${normalizedVersion} not yet released - would dispatch`,
  };
}

export interface TestFlightUpdateCheck {
  ok: boolean;
  appId?: number;
  latestTag?: string;
  build?: TFBuild;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
}

export async function checkForTestFlightUpdate(watch: AppWatch): Promise<TestFlightUpdateCheck> {
  if (!watch.bundleId) {
    return { ok: true, wouldDispatch: false, reason: 'No watch bundle ID configured' };
  }

  let appId: number;
  try {
    appId = (await lookupCurrentVersion(watch.bundleId)).trackId;
  } catch (err) {
    return { ok: false, wouldDispatch: false, reason: `iTunes lookup failed: ${String(err)}` };
  }

  let trains: Awaited<ReturnType<typeof listTrains>>;
  try {
    trains = await listTrains(appId);
  } catch (err) {
    return { ok: false, appId, wouldDispatch: false, reason: `TestFlight trains lookup failed: ${String(err)}` };
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
    return { ok: true, appId, wouldDispatch: false, reason: 'No TestFlight builds found' };
  }

  const latestTag = `v${latestBuild.cfBundleShortVersion}_${latestBuild.cfBundleVersion}`;

  let tagNames: Set<string>;
  try {
    tagNames = await listReleaseTagNames(watch.repo);
  } catch (err) {
    return { ok: false, appId, latestTag, build: latestBuild, wouldDispatch: false, reason: `Failed to list releases: ${String(err)}` };
  }

  if (tagNames.has(latestTag)) {
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

async function pollRunToCompletion(dispatchRepo: string, workflowFile: string, dispatchedAt: Date): Promise<WorkflowRun | undefined> {
  const deadline = Date.now() + config.runPollTimeoutMinutes * 60_000;

  let run: WorkflowRun | undefined;
  while (Date.now() < deadline && !run) {
    run = await findDispatchedRun(dispatchRepo, workflowFile, dispatchedAt);
    if (!run) await sleep(config.runPollIntervalSeconds * 1000);
  }

  if (!run) {
    log.warn('gave up waiting for the dispatched workflow run to appear', { dispatchRepo, workflowFile });
    return undefined;
  }

  while (Date.now() < deadline) {
    run = await getRun(dispatchRepo, run.id);
    if (run.status === 'completed') {
      log.info('dispatched workflow run completed', { runId: run.id, conclusion: run.conclusion });
      return run;
    }
    await sleep(config.runPollIntervalSeconds * 1000);
  }

  log.warn('dispatched workflow run did not complete before timeout', { runId: run.id });
  return run;
}

// What decryptAndDispatch hands back once it knows whether the dispatch itself succeeded -
// separate from trackCompletion, the optional background continuation that watches the
// dispatched workflow run through to completion (which can take many minutes) without the
// scheduler tick blocking on it.
interface DispatchResult {
  outcome: SchedulerRunOutcome;
  trackCompletion?: () => Promise<Partial<SchedulerRunOutcome>>;
}

function trackRunCompletion(
  finished: Job,
  watch: AppWatch,
  versionLabel: string,
  source: 'App Store' | 'TestFlight',
  dispatchedAt: Date,
): () => Promise<Partial<SchedulerRunOutcome>> {
  return async () => {
    try {
      const run = await pollRunToCompletion(watch.repo, watch.ghWorkflowFile, dispatchedAt);
      if (!run) {
        return { runStatus: 'timed_out', reason: `Dispatched ${versionLabel} - gave up waiting for the workflow run to appear/complete` };
      }

      const succeeded = run.conclusion === 'success';
      await notify(succeeded ? 'dispatchSuccess' : 'dispatchFailure', {
        title: succeeded ? 'Decrypted & dispatched' : 'Dispatched, but the workflow failed',
        color: succeeded ? EMBED_COLOR.ok : EMBED_COLOR.err,
        fields: [
          { name: 'App', value: watch.bundleId, inline: true },
          { name: 'Version', value: versionLabel, inline: true },
          { name: 'Source', value: source, inline: true },
          { name: 'Run', value: run.html_url },
        ],
      });
      return {
        runStatus: succeeded ? 'succeeded' : 'failed',
        runUrl: run.html_url,
        reason: `Dispatched ${versionLabel} - workflow ${succeeded ? 'succeeded' : `failed (${run.conclusion})`}`,
      };
    } finally {
      // Only safe to reclaim now - the file has to stay on disk until the dispatched workflow has
      // had its chance to actually download it via the signed URL.
      await reclaimJobFile(finished);
    }
  };
}

async function decryptAndDispatch(job: Job, watch: AppWatch, isTestflight: boolean, versionLabel: string): Promise<DispatchResult> {
  const finished = await waitForJob(job, SCHEDULER_JOB_TIMEOUT_MS);

  if (finished.status !== 'done') {
    log.error('scheduled decrypt did not complete successfully', {
      bundleId: watch.bundleId,
      isTestflight,
      status: finished.status,
      error: finished.error,
    });
    return { outcome: { ok: false, triggered: true, reason: `Decrypt failed: ${finished.error ?? 'unknown error'}` } };
  }

  const dispatchedAt = new Date();
  try {
    const ipaUrl = buildSignedFileUrl(finished.id, config.fileTtlMinutes);
    await dispatchIpaUpdate(watch.repo, ipaUrl, isTestflight);
    log.info('dispatched ipa-update', { dispatchRepo: watch.repo, bundleId: watch.bundleId, isTestflight });
  } catch (err) {
    log.error('dispatch failed', { error: String(err), isTestflight });
    await notify('dispatchFailure', {
      title: 'Dispatch failed',
      color: EMBED_COLOR.err,
      fields: [
        { name: 'App', value: watch.bundleId, inline: true },
        { name: 'Version', value: versionLabel, inline: true },
        { name: 'Error', value: `\`\`\`${String(err)}\`\`\`` },
      ],
    });
    await reclaimJobFile(finished);
    return { outcome: { ok: false, triggered: true, reason: `Failed to dispatch ${versionLabel}: ${String(err)}` } };
  }

  return {
    outcome: { ok: true, triggered: true, reason: `Dispatched ${versionLabel} - waiting on workflow run`, runStatus: 'dispatched' },
    trackCompletion: trackRunCompletion(finished, watch, versionLabel, isTestflight ? 'TestFlight' : 'App Store', dispatchedAt),
  };
}

async function tickAppStore(watch: AppWatch): Promise<DispatchResult> {
  const check = await checkForUpdate(watch);
  if (!check.wouldDispatch) {
    if (check.alreadyReleased) {
      log.info('itunes version already has a matching release, nothing to do', { bundleId: watch.bundleId, version: check.normalizedVersion });
    } else {
      log.error(check.reason, { bundleId: watch.bundleId });
    }
    return { outcome: { ok: check.ok, triggered: false, reason: check.reason } };
  }

  const normalized = check.normalizedVersion as string;
  log.info('no matching release found, decrypting', { bundleId: watch.bundleId, version: normalized });

  const job = enqueueDecryptJob(watch.bundleId, 'scheduler', undefined, undefined, normalized);
  return decryptAndDispatch(job, watch, false, `v${normalized}`);
}

async function tickTestFlight(watch: AppWatch): Promise<DispatchResult> {
  const check = await checkForTestFlightUpdate(watch);
  if (!check.wouldDispatch || !check.build) {
    if (check.alreadyReleased) {
      log.info('TestFlight build already has a matching release, nothing to do', { bundleId: watch.bundleId, tag: check.latestTag });
    } else {
      log.error(check.reason, { bundleId: watch.bundleId });
    }
    return { outcome: { ok: check.ok, triggered: false, reason: check.reason } };
  }

  log.info('no matching release found for latest TestFlight build, installing and decrypting', {
    bundleId: watch.bundleId,
    tag: check.latestTag,
  });

  const job = enqueueDecryptJob(watch.bundleId, 'scheduler', undefined, { appId: check.appId as number, build: check.build });
  return decryptAndDispatch(job, watch, true, check.latestTag as string);
}

const RETRY_BASE_DELAY_MS = 30_000;

async function tickWithRetry(
  fn: (watch: AppWatch) => Promise<DispatchResult>,
  watch: AppWatch,
  retryCount: number,
  label: string,
): Promise<DispatchResult> {
  let result = await fn(watch);
  for (let attempt = 1; attempt <= retryCount && !result.outcome.ok; attempt++) {
    const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    log.warn('scheduler check failed, retrying', { source: label, watchId: watch.id, attempt, maxRetries: retryCount, delayMs, reason: result.outcome.reason });
    await sleep(delayMs);
    result = await fn(watch);
  }
  return result;
}

// Awaits a dispatched run's completion in the background (this can take many minutes) and patches
// the already-recorded history entry with the final status instead of leaving it stuck on
// "dispatched" - then pushes a fresh overview so any connected dashboard picks it up live.
async function trackAndUpdate(
  entryId: string,
  source: 'appStore' | 'testflight',
  trackCompletion: () => Promise<Partial<SchedulerRunOutcome>>,
): Promise<void> {
  try {
    const patch = await trackCompletion();
    updateSchedulerRunOutcome(entryId, source, patch);
  } catch (err) {
    log.error('failed to track dispatched run to completion', { source, error: String(err) });
  } finally {
    emitJobsChanged();
  }
}

const tickInProgress = new Set<string>();

async function tick(watch: AppWatch): Promise<void> {
  if (tickInProgress.has(watch.id)) {
    log.info('scheduler tick already in progress for this watch, skipping', { watchId: watch.id });
    return;
  }
  tickInProgress.add(watch.id);
  try {
    recordSchedulerRun();
    const settings: SchedulerSettings = getEffectiveSettings();
    log.info('scheduler tick', { watchId: watch.id, bundleId: watch.bundleId, repo: watch.repo });

    const appStore = await tickWithRetry(tickAppStore, watch, settings.schedulerRetryCount, 'App Store');
    const testflight = await tickWithRetry(tickTestFlight, watch, settings.schedulerRetryCount, 'TestFlight');
    const entryId = recordSchedulerRunOutcome({
      watchId: watch.id,
      bundleId: watch.bundleId,
      appStore: appStore.outcome,
      testflight: testflight.outcome,
    });

    if (appStore.trackCompletion) void trackAndUpdate(entryId, 'appStore', appStore.trackCompletion);
    if (testflight.trackCompletion) void trackAndUpdate(entryId, 'testflight', testflight.trackCompletion);
  } finally {
    tickInProgress.delete(watch.id);
    // Push a fresh overview to every connected dashboard even when nothing got dispatched -
    // otherwise nextSchedulerRunAt (computed at push time) only ever refreshes on an actual job
    // change, and drifts into showing a past/"expired" time until the next real decrypt happens.
    emitJobsChanged();
  }
}

export function isTickInProgress(watchId: string): boolean {
  return tickInProgress.has(watchId);
}

export async function triggerTickNow(watchId: string): Promise<{ ok: boolean; error?: string }> {
  const watch = getEffectiveWatches().find((w) => w.id === watchId);
  if (!watch) return { ok: false, error: 'watch not found' };
  if (tickInProgress.has(watchId)) {
    return { ok: false, error: 'a scheduler tick is already in progress for this watch' };
  }
  if (!isWatchSchedulable(watch)) {
    return { ok: false, error: 'watch is not schedulable (missing required fields, or GH_TOKEN unset)' };
  }
  void tick(watch).catch((err) => log.error('manually triggered tick threw', { watchId, error: String(err) }));
  return { ok: true };
}

const scheduledTasks = new Map<string, { task: cron.ScheduledTask; cronExpr: string }>();

// Reconciles the live cron schedule against getEffectiveWatches(): schedules/reschedules every
// enabled+schedulable watch whose cron changed or isn't yet scheduled, and stops any watch that's
// no longer eligible. Each watch ticks entirely independently (its own tickInProgress entry, its
// own cron.ScheduledTask), so two watches never block or interleave with each other's timing.
export function applyWatchSchedules(): void {
  const watches = getEffectiveWatches();
  const eligibleIds = new Set(watches.filter(isWatchSchedulable).map((w) => w.id));

  for (const [watchId, scheduled] of scheduledTasks) {
    if (!eligibleIds.has(watchId)) {
      scheduled.task.stop();
      scheduledTasks.delete(watchId);
      log.info('watch no longer schedulable, stopped', { watchId });
    }
  }

  for (const watch of watches) {
    if (!isWatchSchedulable(watch)) continue;
    const existing = scheduledTasks.get(watch.id);
    if (existing && existing.cronExpr === watch.pollCron) continue;

    if (existing) existing.task.stop();
    const task = cron.schedule(watch.pollCron, () => {
      void tick(watch).catch((err) => log.error('scheduler tick threw', { watchId: watch.id, error: String(err) }));
    });
    scheduledTasks.set(watch.id, { task, cronExpr: watch.pollCron });
    log.info('watch (re)scheduled', { watchId: watch.id, cron: watch.pollCron, bundleId: watch.bundleId, repo: watch.repo });
  }

  if (eligibleIds.size === 0) {
    log.info('no schedulable watches: add a bundle ID, app repo, dispatch repo and set GH_TOKEN to enable one');
  }
}

export function startScheduler(): void {
  applyWatchSchedules();
}
