import cron, { type ScheduledTask } from 'node-cron';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import type { Job } from '#jobs/types.js';
import { enqueueDecryptJob, reclaimJobFile, waitForJob } from '#jobs/store.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('scheduler');
import { EMBED_COLOR, notify } from '#notify.js';
import {
  type AppWatch,
  type DispatchTarget,
  createBackupSnapshot,
  getBackupSchedule,
  getEffectiveSettings,
  getEffectiveWatches,
  getWatchDispatchTargets,
  getSchedulerRunHistory,
  isWatchSchedulable,
  recordSchedulerRun,
  recordSchedulerRunOutcome,
  type SchedulerRunOutcome,
  type SchedulerSettings,
  updateSchedulerRunOutcome,
} from '#store/state.js';
import type { TFBuild } from '#testflight.js';
import { listBuilds, listTrains } from '#testflight.js';
import { buildSignedFileUrl } from '#util/signedUrl.js';
import { compareVersions, normalizeVersion } from '#util/version.js';
import { listAppVersions } from '#versions.js';
import { dispatchIpaUpdate, findDispatchedRun, getRun, listReleaseTagNames, listReleaseVersions, type WorkflowRun } from '#scheduler/github.js';
import { lookupCurrentVersion } from '#scheduler/itunes.js';
import { resolveAppStoreDecryptTarget } from '#scheduler/appStoreVersion.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CRON_JITTER_MAX_MS = 20_000;

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

function testFlightTrainMatchesPolicy(trainVersion: string, watch: AppWatch): boolean {
  return watch.testFlightPolicy !== 'train' || trainVersion === watch.testFlightTrain;
}

function isExpiredTestFlightBuild(build: TFBuild): boolean {
  return Boolean(build.expiration && Number.isFinite(Date.parse(build.expiration)) && Date.parse(build.expiration) <= Date.now());
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
  const eligibleTrains = trains.filter((train) => testFlightTrainMatchesPolicy(train.trainVersion, watch));
  if (eligibleTrains.length === 0) {
    return { ok: true, appId, wouldDispatch: false, reason: 'No TestFlight trains matched this watch policy' };
  }

  for (const train of eligibleTrains) {
    let builds: TFBuild[];
    try {
      builds = await listBuilds(appId, train.trainVersion);
    } catch (err) {
      log.error('failed to list TestFlight builds for train', { appId, trainVersion: train.trainVersion, error: String(err) });
      continue;
    }
    for (const build of builds) {
      if (watch.testFlightPolicy === 'latestNonExpired' && isExpiredTestFlightBuild(build)) continue;
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

async function pollRunToCompletion(dispatchRepo: string, workflowFile: string, dispatchedAt: Date, event: 'repository_dispatch' | 'workflow_dispatch' = 'repository_dispatch'): Promise<WorkflowRun | undefined> {
  const deadline = Date.now() + config.runPollTimeoutMinutes * 60_000;

  let run: WorkflowRun | undefined;
  while (Date.now() < deadline && !run) {
    run = await findDispatchedRun(dispatchRepo, workflowFile, dispatchedAt, event);
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

interface DispatchResult {
  outcome: SchedulerRunOutcome;
  trackCompletion?: () => Promise<Partial<SchedulerRunOutcome>>;
}

function trackRunCompletion(
  watch: AppWatch,
  target: DispatchTarget,
  versionLabel: string,
  source: 'App Store' | 'TestFlight',
  dispatchedAt: Date,
): () => Promise<Partial<SchedulerRunOutcome>> {
  return async () => {
      const run = await pollRunToCompletion(target.repo, target.ghWorkflowFile, dispatchedAt, target.mode ?? 'repository_dispatch');
      if (!run) {
        await notify(
          source === 'App Store' ? 'appStoreAutomationFailure' : 'testFlightAutomationFailure',
          {
            title: `${source} automation timed out`,
            color: EMBED_COLOR.err,
            fields: [
              { name: 'App', value: watch.bundleId, inline: true },
              { name: 'Version', value: versionLabel, inline: true },
              { name: 'Stage', value: 'workflow-run poll', inline: true },
            ],
          },
          watch.webhookUrl,
        );
        return { runStatus: 'timed_out', reason: `Dispatched ${versionLabel} - gave up waiting for the workflow run to appear/complete` };
      }

      const succeeded = run.conclusion === 'success';
      await notify(
        succeeded
          ? source === 'App Store'
            ? 'appStoreAutomationSuccess'
            : 'testFlightAutomationSuccess'
          : source === 'App Store'
            ? 'appStoreAutomationFailure'
            : 'testFlightAutomationFailure',
        {
          title: succeeded ? `${source} automation succeeded` : `${source} automation failed`,
          color: succeeded ? EMBED_COLOR.ok : EMBED_COLOR.err,
          fields: [
            { name: 'App', value: watch.bundleId, inline: true },
            { name: 'Version', value: versionLabel, inline: true },
            { name: 'Channel', value: source, inline: true },
            { name: 'Stage', value: 'workflow run', inline: true },
            { name: 'Run', value: run.html_url },
          ],
        },
        watch.webhookUrl,
      );
      return {
        runStatus: succeeded ? 'succeeded' : 'failed',
        runUrl: run.html_url,
        reason: `Dispatched ${versionLabel} - workflow ${succeeded ? 'succeeded' : `failed (${run.conclusion})`}`,
      };
  };
}

function trackRunCompletions(
  finished: Job,
  watch: AppWatch,
  targets: DispatchTarget[],
  versionLabel: string,
  source: 'App Store' | 'TestFlight',
  dispatchedAt: Date,
): () => Promise<Partial<SchedulerRunOutcome>> {
  return async () => {
    try {
      const settled = await Promise.allSettled(targets.map((target) => trackRunCompletion(watch, target, versionLabel, source, dispatchedAt)()));
      const completed = settled
        .filter((result): result is PromiseFulfilledResult<Partial<SchedulerRunOutcome>> => result.status === 'fulfilled')
        .map((result) => result.value);
      const succeeded = completed.filter((result) => result.runStatus === 'succeeded').length;
      const unresolved = targets.length - succeeded;
      return {
        runStatus: unresolved === 0 ? 'succeeded' : succeeded === 0 ? 'failed' : 'timed_out',
        runUrl: completed.find((result) => result.runUrl)?.runUrl,
        reason: `Dispatched ${versionLabel} to ${targets.length} destination${targets.length === 1 ? '' : 's'} - ${succeeded} workflow${succeeded === 1 ? '' : 's'} succeeded${unresolved ? `, ${unresolved} need attention` : ''}`,
      };
    } finally {
      await reclaimJobFile(finished);
    }
  };
}

async function decryptAndDispatch(job: Job, watch: AppWatch, isTestflight: boolean, versionLabel: string, targets: DispatchTarget[]): Promise<DispatchResult> {
  const finished = await waitForJob(job, SCHEDULER_JOB_TIMEOUT_MS);

  if (finished.status !== 'done') {
    log.error('scheduled decrypt did not complete successfully', {
      bundleId: watch.bundleId,
      isTestflight,
      status: finished.status,
      error: finished.error,
    });
    await notify(
      isTestflight ? 'testFlightAutomationFailure' : 'appStoreAutomationFailure',
      {
        title: `${isTestflight ? 'TestFlight' : 'App Store'} automation failed`,
        color: EMBED_COLOR.err,
        fields: [
          { name: 'App', value: watch.bundleId, inline: true },
          { name: 'Version', value: versionLabel, inline: true },
          { name: 'Stage', value: 'decrypt', inline: true },
          { name: 'Reason', value: finished.error ?? 'unknown error' },
        ],
      },
      watch.webhookUrl,
    );
    return { outcome: { ok: false, triggered: true, reason: `Decrypt failed: ${finished.error ?? 'unknown error'}` } };
  }

  const dispatchedAt = new Date();
  try {
    const ipaUrl = buildSignedFileUrl(finished.id, config.fileTtlMinutes);
    const results = await Promise.allSettled(targets.map((target) => dispatchIpaUpdate(target.repo, target.ghWorkflowFile, ipaUrl, isTestflight, target.mode, target.ref, target.inputs)));
    const dispatchedTargets = targets.filter((_, index) => results[index].status === 'fulfilled');
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => String(result.reason));
    if (dispatchedTargets.length === 0) throw new Error(failures.join('; ') || 'all dispatches failed');
    log.info('dispatched ipa-update', { dispatchRepos: dispatchedTargets.map((target) => target.repo), bundleId: watch.bundleId, isTestflight });
    if (failures.length > 0) {
      await notify(
        isTestflight ? 'testFlightAutomationFailure' : 'appStoreAutomationFailure',
        {
          title: `${isTestflight ? 'TestFlight' : 'App Store'} automation partially dispatched`,
          color: EMBED_COLOR.warn,
          fields: [
            { name: 'App', value: watch.bundleId, inline: true },
            { name: 'Version', value: versionLabel, inline: true },
            { name: 'Stage', value: 'dispatch', inline: true },
            { name: 'Reason', value: `${failures.length} destination${failures.length === 1 ? '' : 's'} could not be dispatched` },
          ],
        },
        watch.webhookUrl,
      );
    }
    return {
      outcome: {
        ok: true,
        triggered: true,
        reason: `Dispatched ${versionLabel} to ${dispatchedTargets.length}/${targets.length} destination${targets.length === 1 ? '' : 's'} - waiting on workflow runs`,
        runStatus: 'dispatched',
      },
      trackCompletion: trackRunCompletions(finished, watch, dispatchedTargets, versionLabel, isTestflight ? 'TestFlight' : 'App Store', dispatchedAt),
    };
  } catch (err) {
    log.error('dispatch failed', { error: String(err), isTestflight });
    await notify(
      isTestflight ? 'testFlightAutomationFailure' : 'appStoreAutomationFailure',
      {
        title: `${isTestflight ? 'TestFlight' : 'App Store'} automation failed`,
        color: EMBED_COLOR.err,
        fields: [
          { name: 'App', value: watch.bundleId, inline: true },
          { name: 'Version', value: versionLabel, inline: true },
          { name: 'Stage', value: 'dispatch', inline: true },
          { name: 'Reason', value: String(err) },
        ],
      },
      watch.webhookUrl,
    );
    await reclaimJobFile(finished);
    return { outcome: { ok: false, triggered: true, reason: `Failed to dispatch ${versionLabel}: ${String(err)}` } };
  }

}

async function tickAppStore(watch: AppWatch): Promise<DispatchResult> {
  const targets = getWatchDispatchTargets(watch);
  const checks = await Promise.all(targets.map((target) => checkForUpdate({ ...watch, repo: target.repo, ghWorkflowFile: target.ghWorkflowFile })));
  const dispatchTargets = targets.filter((_, index) => checks[index].wouldDispatch);
  const check = checks.find((candidate) => candidate.wouldDispatch) ?? checks.find((candidate) => !candidate.ok) ?? checks[0];
  if (!check) return { outcome: { ok: false, triggered: false, reason: 'No valid dispatch destinations configured' } };
  if (dispatchTargets.length === 0) {
    if (check.alreadyReleased) {
      log.info('itunes version already has a matching release, nothing to do', { bundleId: watch.bundleId, version: check.normalizedVersion });
    } else {
      log.error(check.reason, { bundleId: watch.bundleId });
      if (!check.ok) {
        await notify(
          'appStoreAutomationFailure',
          {
            title: 'App Store automation failed',
            color: EMBED_COLOR.err,
            fields: [
              { name: 'App', value: watch.bundleId, inline: true },
              { name: 'Stage', value: 'metadata check', inline: true },
              { name: 'Reason', value: check.reason },
            ],
          },
          watch.webhookUrl,
        );
      }
    }
    return { outcome: { ok: check.ok, triggered: false, reason: check.reason } };
  }

  const normalized = check.normalizedVersion as string;

  let externalVersionId: string | undefined;
  try {
    const versions = await listAppVersions(watch.bundleId);
    externalVersionId = resolveAppStoreDecryptTarget(versions, normalized).externalVersionId;
    if (!externalVersionId) {
      log.info('no App Store external version id matched the current version, dispatching an unpinned install that will verify the installed version', {
        bundleId: watch.bundleId,
        version: normalized,
      });
    }
  } catch (err) {
    log.warn('failed to resolve the App Store external version id, dispatching an unpinned install that will verify the installed version', {
      bundleId: watch.bundleId,
      error: String(err),
    });
  }

  log.info('no matching release found, decrypting', { bundleId: watch.bundleId, version: normalized, externalVersionId });

  const job = enqueueDecryptJob(watch.bundleId, 'scheduler', externalVersionId, undefined, normalized);
  const result = await decryptAndDispatch(job, watch, false, `v${normalized}`, dispatchTargets);
  result.outcome = { ...result.outcome, observedVersion: normalized, installMode: externalVersionId ? 'pinned' : 'current' };
  return result;
}

async function tickTestFlight(watch: AppWatch): Promise<DispatchResult> {
  const targets = getWatchDispatchTargets(watch);
  const checks = await Promise.all(targets.map((target) => checkForTestFlightUpdate({ ...watch, repo: target.repo, ghWorkflowFile: target.ghWorkflowFile })));
  const dispatchTargets = targets.filter((_, index) => checks[index].wouldDispatch);
  const check = checks.find((candidate) => candidate.wouldDispatch && candidate.build) ?? checks.find((candidate) => !candidate.ok) ?? checks[0];
  if (!check) return { outcome: { ok: false, triggered: false, reason: 'No valid dispatch destinations configured' } };
  if (dispatchTargets.length === 0 || !check.build) {
    if (check.alreadyReleased) {
      log.info('TestFlight build already has a matching release, nothing to do', { bundleId: watch.bundleId, tag: check.latestTag });
    } else {
      log.error(check.reason, { bundleId: watch.bundleId });
      if (!check.ok) {
        await notify(
          'testFlightAutomationFailure',
          {
            title: 'TestFlight automation failed',
            color: EMBED_COLOR.err,
            fields: [
              { name: 'App', value: watch.bundleId, inline: true },
              { name: 'Stage', value: 'metadata check', inline: true },
              { name: 'Reason', value: check.reason },
            ],
          },
          watch.webhookUrl,
        );
      }
    }
    return { outcome: { ok: check.ok, triggered: false, reason: check.reason } };
  }

  log.info('no matching release found for latest TestFlight build, installing and decrypting', {
    bundleId: watch.bundleId,
    tag: check.latestTag,
  });

  const job = enqueueDecryptJob(watch.bundleId, 'scheduler', undefined, { appId: check.appId as number, build: check.build });
  return decryptAndDispatch(job, watch, true, check.latestTag as string, dispatchTargets);
}

const RETRY_BASE_DELAY_MS = 30_000;

function retryAfterMsFromReason(reason: string): number | undefined {
  const match = /retry after (\d+)s/.exec(reason);
  return match ? Number(match[1]) * 1000 : undefined;
}

async function tickWithRetry(
  fn: (watch: AppWatch) => Promise<DispatchResult>,
  watch: AppWatch,
  retryCount: number,
  label: string,
): Promise<DispatchResult> {
  let result = await fn(watch);
  for (let attempt = 1; attempt <= retryCount && !result.outcome.ok; attempt++) {
    const backoffMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    const rateLimitedMs = retryAfterMsFromReason(result.outcome.reason);
    const delayMs = rateLimitedMs ? Math.max(backoffMs, rateLimitedMs) : backoffMs;
    log.warn('scheduler check failed, retrying', {
      source: label,
      watchId: watch.id,
      attempt,
      maxRetries: retryCount,
      delayMs,
      rateLimited: rateLimitedMs !== undefined,
      reason: result.outcome.reason,
    });
    await sleep(delayMs);
    result = await fn(watch);
  }
  return result;
}

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
  const maintenance = getMaintenanceStatus();
  if (maintenance.active) {
    log.info('skipping scheduler tick, maintenance mode active', { watchId: watch.id, reason: maintenance.reason });
    return;
  }
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

const scheduledTasks = new Map<string, { task: ScheduledTask; cronExpr: string }>();

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

      const jitterMs = Math.random() * CRON_JITTER_MAX_MS;
      setTimeout(() => {
        void tick(watch).catch((err) => log.error('scheduler tick threw', { watchId: watch.id, error: String(err) }));
      }, jitterMs);
    });
    scheduledTasks.set(watch.id, { task, cronExpr: watch.pollCron });
    log.info('watch (re)scheduled', { watchId: watch.id, cron: watch.pollCron, bundleId: watch.bundleId, repo: watch.repo });
  }

  if (eligibleIds.size === 0) {
    log.info('no schedulable watches: add a bundle ID, app repo, dispatch repo and set GH_TOKEN to enable one');
  }
}

let backupTask: ScheduledTask | undefined;
let backupTaskCron: string | undefined;

export function applyBackupSchedule(): void {
  const schedule = getBackupSchedule();

  if (!schedule.enabled || !cron.validate(schedule.cron)) {
    backupTask?.stop();
    backupTask = undefined;
    backupTaskCron = undefined;
    return;
  }

  if (backupTask && backupTaskCron === schedule.cron) return;

  backupTask?.stop();
  backupTask = cron.schedule(schedule.cron, () => {
    try {
      createBackupSnapshot('scheduled');
      log.info('scheduled backup snapshot created');
    } catch (err) {
      log.error('scheduled backup snapshot failed', { error: String(err) });
    }
  });
  backupTaskCron = schedule.cron;
  log.info('backup schedule (re)applied', { cron: schedule.cron });
}

async function reconcileStuckSchedulerRuns(): Promise<void> {
  const entries = getSchedulerRunHistory(20);
  const watches = getEffectiveWatches();

  for (const entry of entries) {
    const watch = watches.find((w) => w.id === entry.watchId);
    if (!watch) continue;

    for (const source of ['appStore', 'testflight'] as const) {
      if (entry[source].runStatus !== 'dispatched') continue;
      log.info('reconciling scheduler run left stuck as dispatched by a previous process', { entryId: entry.id, source, watchId: watch.id });
      try {
        const run = await pollRunToCompletion(watch.repo, watch.ghWorkflowFile, new Date(entry.ts));
        if (!run) {
          updateSchedulerRunOutcome(entry.id, source, {
            runStatus: 'timed_out',
            reason: `${entry[source].reason} - gave up waiting for the workflow run to appear/complete after a restart`,
          });
          continue;
        }
        const succeeded = run.conclusion === 'success';
        updateSchedulerRunOutcome(entry.id, source, {
          runStatus: succeeded ? 'succeeded' : 'failed',
          runUrl: run.html_url,
          reason: `${entry[source].reason} - workflow ${succeeded ? 'succeeded' : `failed (${run.conclusion})`}`,
        });
      } catch (err) {
        log.warn('failed to reconcile stuck scheduler run', { entryId: entry.id, source, error: String(err) });
      }
    }
  }
  emitJobsChanged();
}

export function startScheduler(): void {
  applyWatchSchedules();
  applyBackupSchedule();
  void reconcileStuckSchedulerRuns().catch((err) => log.error('scheduler run reconciliation threw', { error: String(err) }));
}
