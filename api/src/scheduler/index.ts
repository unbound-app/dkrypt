import cron from 'node-cron';
import { config, schedulerEnabled } from '../config.js';
import { enqueueDecryptJob, reclaimJobFile, waitForJob } from '../jobs/store.js';
import { log } from '../logger.js';
import { buildSignedFileUrl } from '../util/signedUrl.js';
import { compareVersions, normalizeVersion } from '../util/version.js';
import { dispatchIpaUpdate, findDispatchedRun, getRun, listReleaseVersions } from './github.js';
import { lookupCurrentVersion } from './itunes.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Never let a decrypt hang the scheduler forever - well past any real decrypt, just a safety net. */
const SCHEDULER_JOB_TIMEOUT_MS = 2 * 60 * 60 * 1000;

async function pollRunToCompletion(dispatchedAt: Date): Promise<void> {
  const deadline = Date.now() + config.runPollTimeoutMinutes * 60_000;

  let runId: number | undefined;
  while (Date.now() < deadline && runId === undefined) {
    const run = await findDispatchedRun(dispatchedAt);
    if (run) {
      runId = run.id;
      break;
    }
    await sleep(config.runPollIntervalSeconds * 1000);
  }

  if (runId === undefined) {
    log.warn('gave up waiting for the dispatched workflow run to appear', {
      dispatchRepo: config.ghDispatchRepo,
      workflowFile: config.ghWorkflowFile,
    });
    return;
  }

  while (Date.now() < deadline) {
    const run = await getRun(runId);
    if (run.status === 'completed') {
      log.info('dispatched workflow run completed', { runId, conclusion: run.conclusion });
      return;
    }
    await sleep(config.runPollIntervalSeconds * 1000);
  }

  log.warn('dispatched workflow run did not complete before timeout', { runId });
}

async function tick(): Promise<void> {
  log.info('scheduler tick', { bundleId: config.watchBundleId, appRepo: config.watchAppRepo });

  let itunesVersion: string;
  try {
    itunesVersion = (await lookupCurrentVersion(config.watchBundleId)).version;
  } catch (err) {
    log.error('itunes lookup failed', { error: String(err) });
    return;
  }

  const normalized = normalizeVersion(itunesVersion);

  let releaseVersions: Set<string>;
  try {
    releaseVersions = await listReleaseVersions(config.watchAppRepo);
  } catch (err) {
    log.error('failed to list releases', { repo: config.watchAppRepo, error: String(err) });
    return;
  }

  const alreadyReleased = [...releaseVersions].some((v) => compareVersions(v, normalized) === 0);
  if (alreadyReleased) {
    log.info('itunes version already has a matching release, nothing to do', {
      bundleId: config.watchBundleId,
      version: normalized,
    });
    return;
  }

  log.info('no matching release found, decrypting', { bundleId: config.watchBundleId, version: normalized });

  const job = enqueueDecryptJob(config.watchBundleId);
  const finished = await waitForJob(job, SCHEDULER_JOB_TIMEOUT_MS);

  if (finished.status !== 'done') {
    log.error('scheduled decrypt did not complete successfully', {
      bundleId: config.watchBundleId,
      status: finished.status,
      error: finished.error,
    });
    return;
  }

  try {
    const ipaUrl = buildSignedFileUrl(finished.id, config.fileTtlMinutes);
    const dispatchedAt = new Date();
    await dispatchIpaUpdate(ipaUrl, false);
    log.info('dispatched ipa-update', { dispatchRepo: config.ghDispatchRepo, bundleId: config.watchBundleId });

    await pollRunToCompletion(dispatchedAt);
  } catch (err) {
    log.error('dispatch/poll failed', { error: String(err) });
  } finally {
    await reclaimJobFile(finished);
  }
}

export function startScheduler(): void {
  if (!schedulerEnabled) {
    log.info('scheduler disabled: set WATCH_BUNDLE_ID, WATCH_APP_REPO, GH_DISPATCH_REPO and GH_TOKEN to enable it');
    return;
  }

  log.info('scheduler enabled', { cron: config.pollCron, bundleId: config.watchBundleId, appRepo: config.watchAppRepo });

  cron.schedule(config.pollCron, () => {
    void tick().catch((err) => log.error('scheduler tick threw', { error: String(err) }));
  });
}
