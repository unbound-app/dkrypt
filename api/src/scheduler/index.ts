import cron from 'node-cron';
import { config } from '../config.js';
import { enqueueDecryptJob, reclaimJobFile, waitForJob } from '../jobs/store.js';
import { scopedLogger } from '../logger.js';

const log = scopedLogger('scheduler');
import { notify } from '../notify.js';
import { getEffectiveSettings, isSchedulerEnabled } from '../store/state.js';
import { buildSignedFileUrl } from '../util/signedUrl.js';
import { compareVersions, normalizeVersion } from '../util/version.js';
import { dispatchIpaUpdate, findDispatchedRun, getRun, listReleaseVersions } from './github.js';
import { lookupCurrentVersion } from './itunes.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Never let a decrypt hang the scheduler forever - well past any real decrypt, just a safety net. */
const SCHEDULER_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

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

async function tick(): Promise<void> {
  const settings = getEffectiveSettings();
  log.info('scheduler tick', { bundleId: settings.watchBundleId, appRepo: settings.watchAppRepo });

  let itunesVersion: string;
  try {
    itunesVersion = (await lookupCurrentVersion(settings.watchBundleId)).version;
  } catch (err) {
    log.error('itunes lookup failed', { error: String(err) });
    return;
  }

  const normalized = normalizeVersion(itunesVersion);

  let releaseVersions: Set<string>;
  try {
    releaseVersions = await listReleaseVersions(settings.watchAppRepo);
  } catch (err) {
    log.error('failed to list releases', { repo: settings.watchAppRepo, error: String(err) });
    return;
  }

  const alreadyReleased = [...releaseVersions].some((v) => compareVersions(v, normalized) === 0);
  if (alreadyReleased) {
    log.info('itunes version already has a matching release, nothing to do', {
      bundleId: settings.watchBundleId,
      version: normalized,
    });
    return;
  }

  log.info('no matching release found, decrypting', { bundleId: settings.watchBundleId, version: normalized });

  const job = enqueueDecryptJob(settings.watchBundleId, 'scheduler');
  const finished = await waitForJob(job, SCHEDULER_JOB_TIMEOUT_MS);

  if (finished.status !== 'done') {
    log.error('scheduled decrypt did not complete successfully', {
      bundleId: settings.watchBundleId,
      status: finished.status,
      error: finished.error,
    });
    return;
  }

  try {
    const ipaUrl = buildSignedFileUrl(finished.id, config.fileTtlMinutes);
    const dispatchedAt = new Date();
    await dispatchIpaUpdate(settings.ghDispatchRepo, ipaUrl, false);
    log.info('dispatched ipa-update', { dispatchRepo: settings.ghDispatchRepo, bundleId: settings.watchBundleId });

    await pollRunToCompletion(settings.ghDispatchRepo, settings.ghWorkflowFile, dispatchedAt);
    await notify(`✅ ipadecrypt-service: **${settings.watchBundleId}** v${normalized} decrypted and dispatched to \`${settings.ghDispatchRepo}\`.`);
  } catch (err) {
    log.error('dispatch/poll failed', { error: String(err) });
    await notify(`⚠️ ipadecrypt-service: dispatch/poll failed for **${settings.watchBundleId}** v${normalized}: ${String(err)}`);
  } finally {
    await reclaimJobFile(finished);
  }
}

let currentTask: cron.ScheduledTask | undefined;
let currentCronExpr: string | undefined;

/** (Re)registers the cron task if the effective POLL_CRON changed since the last call - safe to call anytime settings are updated. */
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
