import cron, { type ScheduledTask } from 'node-cron';
import { trackBackgroundWork } from '#backgroundWork.js';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import type { Job } from '#jobs/types.js';
import { enqueueDecryptJob, ScheduledJobDeferredError, waitForJob, type EnqueueDecryptJobOptions } from '#jobs/store.js';
import { SCHEDULER_JOB_TIMEOUT_MS } from '#jobs/timeouts.js';
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
  markWatchScheduleRun,
  getWatchDispatchTargets,
  getSchedulerRunHistory,
  isWatchSchedulable,
  recordSchedulerRun,
  recordSchedulerRunOutcome,
  recordGitHubBudgetTelemetry,
  type SchedulerRunOutcome,
  type SchedulerSettings,
  DEFAULT_PROJECT_ID,
  updateSchedulerRunOutcome,
} from '#store/state.js';
import { listBuilds, listTrains } from '#testflight.js';
import { dispatchTargetKey, filterPendingDispatchTargets } from '#scheduler/pendingDispatch.js';
import { aggregateWorkflowRunStatus, selectWorkflowRunUrl, workflowRunStatus } from '#scheduler/completion.js';
import { checkForTestFlightUpdate as checkTestFlightUpdate, type TestFlightUpdateCheck } from '#scheduler/testFlightUpdate.js';
import { destinationFailures, summarizeDestinationFailures } from '#scheduler/destinationFailures.js';
import { checkDestinationsWithRetries, classifySchedulerFailure } from '#scheduler/failure.js';
import { normalizeVersion } from '#util/version.js';
import { listAppVersions } from '#versions.js';
import { dispatchIpaUpdate, findDispatchedRun, getGitHubRateLimitBudget, getRun, getWorkflowFailureSummary, measureGitHubRequests, releaseTagExists, releaseVersionExists, type WorkflowRun } from '#scheduler/github.js';
import { lookupCurrentVersion } from '#scheduler/itunes.js';
import { resolveAppStoreDecryptTarget } from '#scheduler/appStoreVersion.js';
import { buildArtifactFileUrl, getArtifactById } from '#artifacts.js';
import { effectiveTimeZone } from '#util/timezone.js';
import { isWithinMaintenanceWindow, maintenanceWindowEndAt } from '#util/maintenanceWindow.js';
import { nextMissedCronRunAt } from '#util/cron.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CRON_JITTER_MAX_MS = 20_000;

const GITHUB_RATE_LIMIT_RESERVE = 100;
const GITHUB_RATE_LIMIT_RETRY_PADDING_MS = 5_000;

export interface UpdateCheck {
  ok: boolean;
  itunesVersion?: string;
  normalizedVersion?: string;
  alreadyReleased?: boolean;
  wouldDispatch: boolean;
  reason: string;
  failureClass?: SchedulerRunOutcome['failureClass'];
  retryable?: boolean;
}

export async function checkForUpdate(watch: AppWatch): Promise<UpdateCheck> {
  let itunesVersion: string;
  try {
    itunesVersion = (await lookupCurrentVersion(watch.bundleId)).version;
  } catch (err) {
    return { ok: false, wouldDispatch: false, reason: `iTunes lookup failed: ${String(err)}`, ...classifySchedulerFailure(err) };
  }

  const normalizedVersion = normalizeVersion(itunesVersion);

  let alreadyReleased: boolean;
  try {
    alreadyReleased = await releaseVersionExists(watch.repo, normalizedVersion);
  } catch (err) {
    return {
      ok: false,
      itunesVersion,
      normalizedVersion,
      wouldDispatch: false,
      reason: `Failed to verify releases: ${String(err)}`,
      ...classifySchedulerFailure(err),
    };
  }

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

export { type TestFlightUpdateCheck } from '#scheduler/testFlightUpdate.js';

export function checkForTestFlightUpdate(watch: AppWatch): Promise<TestFlightUpdateCheck> {
  return checkTestFlightUpdate(watch, {
    lookupCurrentVersion,
    listTrains,
    listBuilds: async (appId, trainVersion) => {
      try {
        return await listBuilds(appId, trainVersion);
      } catch (error) {
        log.error('failed to list TestFlight builds for train', { appId, trainVersion, error: String(error) });
        throw error;
      }
    },
    releaseTagExists,
  });
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

type ScheduledEnqueueResult = { kind: 'job'; job: Job } | { kind: 'deferred'; reason: string };

function enqueueScheduledDecryptJob(bundleId: string, options: EnqueueDecryptJobOptions): ScheduledEnqueueResult {
  try {
    return {
      kind: 'job',
      job: enqueueDecryptJob(bundleId, 'scheduler', { ...options, deferWhenNoDispatchableDevice: true }),
    };
  } catch (error) {
    if (!(error instanceof ScheduledJobDeferredError)) throw error;
    log.info('scheduled decrypt deferred because no device can start the job', { bundleId, reason: error.message });
    return { kind: 'deferred', reason: error.message };
  }
}

function deferredScheduledDecryptResult(versionLabel: string, reason: string): DispatchResult {
  return { outcome: { ok: true, triggered: false, versionLabel, reason: `Scheduled decrypt deferred: ${reason}` } };
}

async function workflowFailureSummary(repo: string, run: WorkflowRun): Promise<string | undefined> {
  try {
    return await getWorkflowFailureSummary(repo, run.id);
  } catch (error) {
    log.warn('failed to load failed workflow job details', { repo, runId: run.id, error: String(error) });
    return undefined;
  }
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

      const runStatus = workflowRunStatus(run);
      if (runStatus === 'timed_out') {
        await notify(
          source === 'App Store' ? 'appStoreAutomationFailure' : 'testFlightAutomationFailure',
          {
            title: `${source} automation timed out`,
            color: EMBED_COLOR.warn,
            fields: [
              { name: 'App', value: watch.bundleId, inline: true },
              { name: 'Version', value: versionLabel, inline: true },
              { name: 'Stage', value: 'workflow run poll', inline: true },
              { name: 'Run', value: run.html_url },
            ],
          },
          watch.webhookUrl,
        );
        return {
          runStatus,
          runUrl: run.html_url,
          reason: `Dispatched ${versionLabel} - workflow was still ${run.status} when polling timed out`,
        };
      }

      const succeeded = runStatus === 'succeeded';
      const failureSummary = succeeded ? undefined : await workflowFailureSummary(target.repo, run);
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
            ...(failureSummary ? [{ name: 'Failed job or step', value: failureSummary }] : []),
            { name: 'Run', value: run.html_url },
          ],
        },
        watch.webhookUrl,
      );
      return {
        runStatus,
        runUrl: run.html_url,
        failureSummary,
        reason: `Dispatched ${versionLabel} - workflow ${succeeded ? 'succeeded' : `failed (${run.conclusion})${failureSummary ? `: ${failureSummary}` : ''}`}`,
      };
  };
}

function trackRunCompletions(
  watch: AppWatch,
  targets: DispatchTarget[],
  versionLabel: string,
  source: 'App Store' | 'TestFlight',
  dispatchedAt: Date,
): () => Promise<Partial<SchedulerRunOutcome>> {
  return async () => {
    const settled = await Promise.allSettled(targets.map((target) => trackRunCompletion(watch, target, versionLabel, source, dispatchedAt)()));
    const completed = settled
      .filter((result): result is PromiseFulfilledResult<Partial<SchedulerRunOutcome>> => result.status === 'fulfilled')
      .map((result) => result.value);
    const succeeded = completed.filter((result) => result.runStatus === 'succeeded').length;
    const unresolved = targets.length - succeeded;
    const failureSummaries = completed.flatMap((result) => result.failureSummary ? [result.failureSummary] : []).slice(0, 3);
    const failureSummary = failureSummaries.length ? failureSummaries.join('; ').slice(0, 320) : undefined;
    return {
      runStatus: aggregateWorkflowRunStatus(completed, targets.length),
      runUrl: selectWorkflowRunUrl(completed),
      failureSummary,
      reason: `Dispatched ${versionLabel} to ${targets.length} destination${targets.length === 1 ? '' : 's'} - ${succeeded} workflow${succeeded === 1 ? '' : 's'} succeeded${unresolved ? `, ${unresolved} need attention` : ''}`,
    };
  };
}

async function decryptAndDispatch(job: Job, watch: AppWatch, isTestflight: boolean, versionLabel: string, targets: DispatchTarget[]): Promise<DispatchResult> {
  const outcomeMetadata = { versionLabel, dispatchTargetKeys: [] as string[] };
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
    return {
      outcome: {
        ...outcomeMetadata,
        ...classifySchedulerFailure(finished.error),
        ok: false,
        triggered: true,
        retryable: false,
        reason: `Decrypt failed: ${finished.error ?? 'unknown error'}`,
      },
    };
  }

  const dispatchedAt = new Date();
  try {
    const artifact = finished.artifactId ? getArtifactById(finished.artifactId) : undefined;
    if (!artifact) throw new Error('decrypt completed without a downloadable artifact');
    const ipaUrl = buildArtifactFileUrl(artifact.id);
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
        versionLabel,
        dispatchTargetKeys: dispatchedTargets.map(dispatchTargetKey),
      },
      trackCompletion: trackRunCompletions(watch, dispatchedTargets, versionLabel, isTestflight ? 'TestFlight' : 'App Store', dispatchedAt),
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
    return {
      outcome: {
        ...outcomeMetadata,
        ...classifySchedulerFailure(err),
        ok: false,
        triggered: true,
        retryable: false,
        reason: `Failed to dispatch ${versionLabel}: ${String(err)}`,
      },
    };
  }

}

function retryAfterMsFromReason(reason: string): number | undefined {
  const match = /retry after (\d+)s/.exec(reason);
  return match ? Number(match[1]) * 1000 : undefined;
}

function retryDestinationChecks<T extends { ok: boolean; reason: string; retryable?: boolean }>(
  source: 'App Store' | 'TestFlight',
  watch: AppWatch,
  targets: DispatchTarget[],
  retryCount: number,
  checkTarget: (target: DispatchTarget) => Promise<T>,
): Promise<T[]> {
  return checkDestinationsWithRetries(
    targets,
    checkTarget,
    retryCount,
    sleep,
    (target, { attempt, delayMs, reason }) => log.warn('scheduler destination check failed, retrying', {
      source,
      watchId: watch.id,
      destination: target.repo,
      attempt,
      maxRetries: retryCount,
      delayMs,
      rateLimited: retryAfterMsFromReason(reason) !== undefined,
      reason,
    }),
    retryAfterMsFromReason,
  );
}

async function tickAppStore(watch: AppWatch, retryCount: number): Promise<DispatchResult> {
  const targets = getWatchDispatchTargets(watch);
  const checks = await retryDestinationChecks(
    'App Store',
    watch,
    targets,
    retryCount,
    (target) => checkForUpdate({ ...watch, repo: target.repo, ghWorkflowFile: target.ghWorkflowFile }),
  );
  const failedDestinations = destinationFailures(targets, checks);
  const failureSummary = summarizeDestinationFailures(failedDestinations);
  const candidateDispatchTargets = targets.filter((_, index) => checks[index].wouldDispatch);
  const check = checks.find((candidate) => candidate.wouldDispatch) ?? checks.find((candidate) => !candidate.ok) ?? checks[0];
  if (!check) return { outcome: { ok: false, triggered: false, reason: 'No valid dispatch destinations configured' } };
  const versionLabel = check.normalizedVersion ? `v${check.normalizedVersion}` : undefined;
  const dispatchTargets = versionLabel
    ? filterPendingDispatchTargets(candidateDispatchTargets, getSchedulerRunHistory(20, watch.id), 'App Store', versionLabel)
    : candidateDispatchTargets;
  if (dispatchTargets.length === 0) {
    if (candidateDispatchTargets.length > 0 && !check.alreadyReleased && versionLabel) {
      log.info('itunes version already has a pending dispatch, nothing to do', { bundleId: watch.bundleId, version: check.normalizedVersion });
      return {
        outcome: {
          ok: true,
          triggered: false,
          versionLabel,
          reason: `${versionLabel} already dispatched; workflow still pending${failedDestinations.length ? `; ${failedDestinations.length} destination${failedDestinations.length === 1 ? '' : 's'} could not be checked` : ''}`,
          failureClass: failedDestinations[0]?.check.failureClass,
          destinationFailureSummary: failureSummary,
        },
      };
    }
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
    return {
      outcome: {
        ok: check.ok,
        triggered: false,
        versionLabel,
        reason: failureSummary ?? check.reason,
        destinationFailureSummary: failureSummary,
        failureClass: check.failureClass,
        retryable: check.ok ? undefined : failedDestinations.some((failure) => failure.check.retryable),
      },
    };
  }

  const normalized = check.normalizedVersion as string;

  let externalVersionId: string | undefined;
  let minimumOsVersion: string | undefined;
  try {
    const versions = await listAppVersions(watch.bundleId);
    const target = resolveAppStoreDecryptTarget(versions, normalized);
    externalVersionId = target.externalVersionId;
    minimumOsVersion = target.minimumOsVersion;
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

  const enqueueResult = enqueueScheduledDecryptJob(watch.bundleId, {
    externalVersionId,
    versionLabel: normalized,
    projectId: watch.projectId ?? DEFAULT_PROJECT_ID,
    minimumOsVersion,
  });
  const result = enqueueResult.kind === 'deferred'
    ? deferredScheduledDecryptResult(`v${normalized}`, enqueueResult.reason)
    : await decryptAndDispatch(enqueueResult.job, watch, false, `v${normalized}`, dispatchTargets);
  if (failureSummary) {
    log.warn('App Store update check failed for some destinations', { bundleId: watch.bundleId, failures: failedDestinations });
    result.outcome = {
      ...result.outcome,
      reason: `${result.outcome.reason}; ${failedDestinations.length} destination${failedDestinations.length === 1 ? '' : 's'} could not be checked`,
      failureClass: result.outcome.failureClass ?? failedDestinations[0]?.check.failureClass,
      destinationFailureSummary: failureSummary,
    };
  }
  result.outcome = { ...result.outcome, observedVersion: normalized, installMode: externalVersionId ? 'pinned' : 'current' };
  return result;
}

async function tickTestFlight(watch: AppWatch, retryCount: number): Promise<DispatchResult> {
  const targets = getWatchDispatchTargets(watch);
  const checks = await retryDestinationChecks(
    'TestFlight',
    watch,
    targets,
    retryCount,
    (target) => checkForTestFlightUpdate({ ...watch, repo: target.repo, ghWorkflowFile: target.ghWorkflowFile }),
  );
  const failedDestinations = destinationFailures(targets, checks);
  const failureSummary = summarizeDestinationFailures(failedDestinations);
  const candidateDispatchTargets = targets.filter((_, index) => checks[index].wouldDispatch);
  const check = checks.find((candidate) => candidate.wouldDispatch && candidate.build) ?? checks.find((candidate) => !candidate.ok) ?? checks[0];
  if (!check) return { outcome: { ok: false, triggered: false, reason: 'No valid dispatch destinations configured' } };
  const versionLabel = check.latestTag;
  const dispatchTargets = versionLabel
    ? filterPendingDispatchTargets(candidateDispatchTargets, getSchedulerRunHistory(20, watch.id), 'TestFlight', versionLabel)
    : candidateDispatchTargets;
  if (dispatchTargets.length === 0 || !check.build) {
    if (candidateDispatchTargets.length > 0 && !check.alreadyReleased && versionLabel && dispatchTargets.length === 0) {
      log.info('TestFlight build already has a pending dispatch, nothing to do', { bundleId: watch.bundleId, tag: check.latestTag });
      return {
        outcome: {
          ok: true,
          triggered: false,
          versionLabel,
          reason: `${versionLabel} already dispatched; workflow still pending${failedDestinations.length ? `; ${failedDestinations.length} destination${failedDestinations.length === 1 ? '' : 's'} could not be checked` : ''}`,
          failureClass: failedDestinations[0]?.check.failureClass,
          destinationFailureSummary: failureSummary,
        },
      };
    }
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
    return {
      outcome: {
        ok: check.ok,
        triggered: false,
        versionLabel,
        reason: failureSummary ?? check.reason,
        destinationFailureSummary: failureSummary,
        failureClass: check.failureClass,
        retryable: check.ok ? undefined : failedDestinations.some((failure) => failure.check.retryable),
      },
    };
  }

  log.info('no matching release found for latest TestFlight build, installing and decrypting', {
    bundleId: watch.bundleId,
    tag: check.latestTag,
  });

  const enqueueResult = enqueueScheduledDecryptJob(watch.bundleId, {
    testflight: { appId: check.appId as number, build: check.build },
    projectId: watch.projectId ?? DEFAULT_PROJECT_ID,
  });
  const result = enqueueResult.kind === 'deferred'
    ? deferredScheduledDecryptResult(check.latestTag as string, enqueueResult.reason)
    : await decryptAndDispatch(enqueueResult.job, watch, true, check.latestTag as string, dispatchTargets);
  if (failureSummary) {
    log.warn('TestFlight update check failed for some destinations', { bundleId: watch.bundleId, failures: failedDestinations });
    result.outcome = {
      ...result.outcome,
      reason: `${result.outcome.reason}; ${failedDestinations.length} destination${failedDestinations.length === 1 ? '' : 's'} could not be checked`,
      failureClass: result.outcome.failureClass ?? failedDestinations[0]?.check.failureClass,
      destinationFailureSummary: failureSummary,
    };
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
const budgetRetryTimers = new Map<string, NodeJS.Timeout>();
const schedulerJitterTimers = new Set<NodeJS.Timeout>();
const maintenanceWindowTimers = new Map<string, NodeJS.Timeout>();
let schedulerStopping = false;
let githubBudgetReservation = { resetAt: 0, requests: 0 };

function estimateGitHubRequests(watch: AppWatch, retryCount: number): number {
  return Math.max(20, getWatchDispatchTargets(watch).length * 12) * (retryCount + 1);
}

function reserveGitHubBudget(watch: AppWatch, retryCount: number, budget: { remaining: number; resetAt: number }): number | undefined {
  if (githubBudgetReservation.resetAt !== budget.resetAt) {
    githubBudgetReservation = { resetAt: budget.resetAt, requests: 0 };
  }
  const estimatedRequests = estimateGitHubRequests(watch, retryCount);
  if (budget.remaining - githubBudgetReservation.requests - estimatedRequests < GITHUB_RATE_LIMIT_RESERVE) return undefined;
  githubBudgetReservation.requests += estimatedRequests;
  return estimatedRequests;
}

function scheduleGitHubBudgetRetry(watchId: string, resetAt: number): void {
  if (budgetRetryTimers.has(watchId)) return;
  const delayMs = Math.max(GITHUB_RATE_LIMIT_RETRY_PADDING_MS, resetAt - Date.now() + GITHUB_RATE_LIMIT_RETRY_PADDING_MS);
  const timer = setTimeout(() => {
    budgetRetryTimers.delete(watchId);
    if (schedulerStopping) return;
    const watch = getEffectiveWatches().find((candidate) => candidate.id === watchId);
    if (!watch || !isWatchSchedulable(watch)) return;
    void trackBackgroundWork('scheduler-tick', () => tick(watch, 'scheduled', true))
      .catch((err: unknown) => log.error('deferred scheduler tick threw', { watchId, error: String(err) }));
  }, delayMs);
  timer.unref();
  budgetRetryTimers.set(watchId, timer);
}

function scheduleMaintenanceWindowResume(watchId: string, resumeAt: number): void {
  const existing = maintenanceWindowTimers.get(watchId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    maintenanceWindowTimers.delete(watchId);
    if (schedulerStopping) return;
    const watch = getEffectiveWatches().find((candidate) => candidate.id === watchId);
    if (!watch || !isWatchSchedulable(watch)) return;
    const timezone = effectiveTimeZone(watch.timezone);
    if (isWithinMaintenanceWindow(watch.maintenanceWindow, timezone)) {
      const nextResumeAt = maintenanceWindowEndAt(watch.maintenanceWindow, timezone);
      if (nextResumeAt !== undefined) {
        scheduleMaintenanceWindowResume(watch.id, nextResumeAt);
      } else {
        log.error('could not determine when the maintenance window ends; scheduled tick remains deferred', { watchId, timezone });
      }
      return;
    }
    startTrackedTick(watch, 'scheduled');
  }, Math.max(1, resumeAt - Date.now()));
  timer.unref();
  maintenanceWindowTimers.set(watchId, timer);
}

async function tick(watch: AppWatch, mode: 'scheduled' | 'manual' = 'scheduled', forceGitHubBudgetRefresh = false): Promise<void> {
  const maintenance = getMaintenanceStatus();
  if (maintenance.active) {
    log.info('skipping scheduler tick, maintenance mode active', { watchId: watch.id, reason: maintenance.reason });
    return;
  }
  if (mode === 'scheduled') {
    const timezone = effectiveTimeZone(watch.timezone);
    if (isWithinMaintenanceWindow(watch.maintenanceWindow, timezone)) {
      const resumeAt = maintenanceWindowEndAt(watch.maintenanceWindow, timezone);
      if (resumeAt === undefined) {
        log.error('could not determine when the maintenance window ends; scheduled tick skipped', { watchId: watch.id, timezone });
        return;
      }
      log.info('deferring scheduler tick until the maintenance window ends', { watchId: watch.id, timezone, resumeAt });
      scheduleMaintenanceWindowResume(watch.id, resumeAt);
      return;
    }
  }
  if (tickInProgress.has(watch.id)) {
    log.info('scheduler tick already in progress for this watch, skipping', { watchId: watch.id });
    return;
  }
  tickInProgress.add(watch.id);
  let githubBudget: { limit: number; remaining: number; resetAt: number } | undefined;
  let estimatedRequests: number | undefined;
  let actualGitHubRequests: number | undefined;
  let deferredForGitHubBudget = false;
  try {
    recordSchedulerRun();
    const settings: SchedulerSettings = getEffectiveSettings();
    log.info('scheduler tick', { watchId: watch.id, bundleId: watch.bundleId, repo: watch.repo });

    if (mode === 'scheduled') {
      const budget = await getGitHubRateLimitBudget(forceGitHubBudgetRefresh).catch((err) => {
        log.warn('could not read GitHub rate limit before scheduler tick', { watchId: watch.id, error: String(err) });
        return undefined;
      });
      githubBudget = budget;
      estimatedRequests = budget ? reserveGitHubBudget(watch, settings.schedulerRetryCount, budget) : undefined;
      if (budget && estimatedRequests === undefined) {
        deferredForGitHubBudget = true;
        const retryAt = new Date(budget.resetAt + GITHUB_RATE_LIMIT_RETRY_PADDING_MS).toISOString();
        const reason = `deferred to preserve GitHub API budget (${budget.remaining}/${budget.limit} remaining; retrying after reset at ${retryAt})`;
        log.warn('deferring scheduler tick for GitHub API budget', { watchId: watch.id, reservedRequests: githubBudgetReservation.requests, ...budget });
        recordSchedulerRunOutcome({
          watchId: watch.id,
          bundleId: watch.bundleId,
          appStore: { ok: true, triggered: false, reason },
          testflight: { ok: true, triggered: false, reason },
        });
        scheduleGitHubBudgetRetry(watch.id, budget.resetAt);
        return;
      }
    }

    const measured = await measureGitHubRequests(async () => ({
      appStore: await tickAppStore(watch, settings.schedulerRetryCount),
      testflight: await tickTestFlight(watch, settings.schedulerRetryCount),
    }));
    actualGitHubRequests = measured.requests;
    const { appStore, testflight } = measured.value;
    const entryId = recordSchedulerRunOutcome({
      watchId: watch.id,
      bundleId: watch.bundleId,
      appStore: appStore.outcome,
      testflight: testflight.outcome,
    });

    const trackAppStoreCompletion = appStore.trackCompletion;
    if (trackAppStoreCompletion) {
      void trackBackgroundWork('scheduler-run-reconciliation', () => trackAndUpdate(entryId, 'appStore', trackAppStoreCompletion))
        .catch((error: unknown) => log.error('scheduler completion reconciliation failed', { entryId, source: 'appStore', error: String(error) }));
    }
    const trackTestFlightCompletion = testflight.trackCompletion;
    if (trackTestFlightCompletion) {
      void trackBackgroundWork('scheduler-run-reconciliation', () => trackAndUpdate(entryId, 'testflight', trackTestFlightCompletion))
        .catch((error: unknown) => log.error('scheduler completion reconciliation failed', { entryId, source: 'testflight', error: String(error) }));
    }
  } finally {
    if (githubBudget && estimatedRequests !== undefined) {
      recordGitHubBudgetTelemetry({
        watchId: watch.id,
        bundleId: watch.bundleId,
        estimatedRequests,
        observedRequests: actualGitHubRequests,
        limit: githubBudget.limit,
        remainingBefore: githubBudget.remaining,
        remainingAfter: undefined,
        resetAt: githubBudget.resetAt,
      });
    }
    tickInProgress.delete(watch.id);
    if (mode === 'scheduled' && !deferredForGitHubBudget) markWatchScheduleRun(watch.id);

    emitJobsChanged();
  }
}

function startTrackedTick(watch: AppWatch, mode: 'scheduled' | 'manual' = 'scheduled', forceGitHubBudgetRefresh = false): void {
  void trackBackgroundWork('scheduler-tick', () => tick(watch, mode, forceGitHubBudgetRefresh))
    .catch((error: unknown) => log.error('scheduler tick threw', { watchId: watch.id, error: String(error) }));
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
  startTrackedTick(watch, 'manual');
  return { ok: true };
}

const scheduledTasks = new Map<string, { task: ScheduledTask; scheduleKey: string }>();

export function applyWatchSchedules(): void {
  if (schedulerStopping) return;
  const watches = getEffectiveWatches();
  const eligibleIds = new Set(watches.filter(isWatchSchedulable).map((w) => w.id));

  for (const [watchId, scheduled] of scheduledTasks) {
    if (!eligibleIds.has(watchId)) {
      scheduled.task.stop();
      scheduledTasks.delete(watchId);
      const timer = maintenanceWindowTimers.get(watchId);
      if (timer) clearTimeout(timer);
      maintenanceWindowTimers.delete(watchId);
      log.info('watch no longer schedulable, stopped', { watchId });
    }
  }

  for (const watch of watches) {
    if (!isWatchSchedulable(watch)) continue;
    const existing = scheduledTasks.get(watch.id);
    const timezone = effectiveTimeZone(watch.timezone);
    const scheduleKey = JSON.stringify([watch.pollCron, timezone, watch.maintenanceWindow?.start, watch.maintenanceWindow?.end]);
    if (existing && existing.scheduleKey === scheduleKey) continue;

    if (existing) {
      existing.task.stop();
      const timer = maintenanceWindowTimers.get(watch.id);
      if (timer) clearTimeout(timer);
      maintenanceWindowTimers.delete(watch.id);
    }
    const task = cron.schedule(watch.pollCron, () => {

      const jitterMs = Math.random() * CRON_JITTER_MAX_MS;
      const timer = setTimeout(() => {
        schedulerJitterTimers.delete(timer);
        if (schedulerStopping) return;
        const currentWatch = getEffectiveWatches().find((candidate) => candidate.id === watch.id);
        if (currentWatch && isWatchSchedulable(currentWatch)) startTrackedTick(currentWatch);
      }, jitterMs);
      schedulerJitterTimers.add(timer);
      timer.unref();
    }, { timezone });
    scheduledTasks.set(watch.id, { task, scheduleKey });
    log.info('watch (re)scheduled', { watchId: watch.id, cron: watch.pollCron, timezone, bundleId: watch.bundleId, repo: watch.repo });
  }

  if (eligibleIds.size === 0) {
    log.info('no schedulable watches: add a bundle ID, app repo, dispatch repo and set GH_TOKEN to enable one');
  }
}

let backupTask: ScheduledTask | undefined;
let backupTaskCron: string | undefined;

export function applyBackupSchedule(): void {
  if (schedulerStopping) return;
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
      const backup = createBackupSnapshot('scheduled');
      if (backup.restoreDrillStatus === 'passed') {
        log.info('scheduled backup snapshot created and restore-tested', { filename: backup.filename });
      } else {
        log.error('scheduled backup snapshot restore verification failed', { filename: backup.filename, checks: backup.restoreDrillChecks });
      }
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
      const recordedTargetKeys = entry[source].dispatchTargetKeys;
      const dispatchTargetKeys = recordedTargetKeys ?? [];
      const hasRecordedTargetKeys = dispatchTargetKeys.length > 0;
      const configuredTargets = getWatchDispatchTargets(watch);
      const targets = hasRecordedTargetKeys
        ? configuredTargets.filter((target) => dispatchTargetKeys.includes(dispatchTargetKey(target)))
        : [{ repo: watch.repo, ghWorkflowFile: watch.ghWorkflowFile }];
      const expectedTargetCount = hasRecordedTargetKeys ? dispatchTargetKeys.length : 1;
      const outcomes = await Promise.all(targets.map(async (target): Promise<Partial<SchedulerRunOutcome>> => {
        try {
          const run = await pollRunToCompletion(target.repo, target.ghWorkflowFile, new Date(entry.ts), target.mode ?? 'repository_dispatch');
          if (!run) {
            return {
              runStatus: 'timed_out',
              reason: `${target.repo}/${target.ghWorkflowFile} - workflow run did not appear or complete after restart`,
            };
          }
          const runStatus = workflowRunStatus(run);
          if (runStatus === 'timed_out') {
            return {
              runStatus,
              runUrl: run.html_url,
              reason: `${target.repo}/${target.ghWorkflowFile} - workflow was still ${run.status} after restart polling timed out`,
            };
          }
          const succeeded = runStatus === 'succeeded';
          const failureSummary = succeeded ? undefined : await workflowFailureSummary(target.repo, run);
          return {
            runStatus,
            runUrl: run.html_url,
            failureSummary,
            reason: `${target.repo}/${target.ghWorkflowFile} - workflow ${succeeded ? 'succeeded' : `failed (${run.conclusion})${failureSummary ? `: ${failureSummary}` : ''}`}`,
          };
        } catch (error) {
          log.warn('failed to reconcile a dispatched workflow target', {
            entryId: entry.id,
            source,
            repo: target.repo,
            workflow: target.ghWorkflowFile,
            error: String(error),
          });
          return {
            runStatus: 'timed_out',
            reason: `${target.repo}/${target.ghWorkflowFile} - workflow reconciliation could not reach GitHub`,
          };
        }
      }));
      const failureSummaries = outcomes.flatMap((outcome) => outcome.failureSummary ? [outcome.failureSummary] : []).slice(0, 3);
      const failureSummary = failureSummaries.length ? failureSummaries.join('; ').slice(0, 320) : undefined;
      const runUrl = selectWorkflowRunUrl(outcomes);
      const unresolvedTargets = Math.max(0, expectedTargetCount - outcomes.length);
      updateSchedulerRunOutcome(entry.id, source, {
        runStatus: aggregateWorkflowRunStatus(outcomes, expectedTargetCount),
        runUrl,
        failureSummary,
        reason: `${entry[source].reason} - reconciled ${outcomes.length}/${expectedTargetCount} dispatched workflow target${expectedTargetCount === 1 ? '' : 's'}${unresolvedTargets ? `; ${unresolvedTargets} target(s) are no longer configured` : ''}${outcomes.length ? `: ${outcomes.map((outcome) => outcome.reason).join('; ')}` : ''}`,
      });
    }
  }
  emitJobsChanged();
}

export function startScheduler(): void {
  schedulerStopping = false;
  applyWatchSchedules();
  const now = Date.now();
  for (const watch of getEffectiveWatches().filter(isWatchSchedulable)) {
    if (watch.lastScheduledAt === undefined) {
      markWatchScheduleRun(watch.id, now);
      continue;
    }
    if (watch.missedRunPolicy !== 'runOnce') continue;
    const missedAt = nextMissedCronRunAt(watch.pollCron, effectiveTimeZone(watch.timezone), watch.lastScheduledAt, now);
    if (missedAt === undefined) continue;
    log.info('running one coalesced missed scheduler check after restart', { watchId: watch.id, missedAt, policy: watch.missedRunPolicy });
    startTrackedTick(watch, 'scheduled');
  }
  applyBackupSchedule();
  void trackBackgroundWork('scheduler-restart-reconciliation', reconcileStuckSchedulerRuns)
    .catch((error: unknown) => log.error('scheduler run reconciliation threw', { error: String(error) }));
}

export function stopScheduler(): void {
  schedulerStopping = true;
  for (const scheduled of scheduledTasks.values()) scheduled.task.stop();
  scheduledTasks.clear();
  backupTask?.stop();
  backupTask = undefined;
  backupTaskCron = undefined;
  for (const timer of schedulerJitterTimers) clearTimeout(timer);
  schedulerJitterTimers.clear();
  for (const timer of maintenanceWindowTimers.values()) clearTimeout(timer);
  maintenanceWindowTimers.clear();
  for (const timer of budgetRetryTimers.values()) clearTimeout(timer);
  budgetRetryTimers.clear();
}
