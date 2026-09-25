import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '#config.js';
import { emitJobsChanged } from '#events.js';
import { scopedLogger } from '#logger.js';
import { recordDeviceActivity, type DeviceRecord } from '#store/state.js';
import { buildAppStoreOperationId, installFromAppStore } from '#appStoreInstall.js';
import { installBuild } from '#testflight.js';
import { getDeviceHealth, getDeviceInstallBlocker } from '#deviceHealth.js';
import { lookupCurrentVersion, type ItunesLookupResult } from '#scheduler/itunes.js';
import { extractIpaMetadata } from '#util/ipaMetadata.js';
import { classifyIpaDecryptOutput } from '#util/ipadecryptOutput.js';
import { artifactKeyForJob, promoteArtifact } from '#artifacts.js';
import { withIpadecrypt } from '#idevice.js';
import { terminateChildProcess } from '#jobs/process.js';
import { currentCorrelation } from '#correlation.js';
import { startSpan } from '#telemetry.js';
import { abortedOperationError, throwIfAborted } from '#util/abort.js';

const log = scopedLogger('jobs');
import { appendJobTimelineEvent, type Job } from '#jobs/types.js';

export async function runDecrypt(job: Job, device: DeviceRecord, signal?: AbortSignal): Promise<void> {
  const span = startSpan('job.decrypt', { 'job.id': job.id, 'job.bundle_id': job.bundleId, 'job.device_id': device.id }, currentCorrelation()?.traceContext);
  try {
    await runDecryptOperation(job, device, signal);
    span.end();
  } catch (error) {
    if (job.filePath?.includes('/.staging/')) await rm(job.filePath, { force: true }).catch(() => {});
    span.end(error);
    throw error;
  }
}

async function runDecryptOperation(job: Job, device: DeviceRecord, signal?: AbortSignal): Promise<void> {
  const recordTimeline = (label: string) => appendJobTimelineEvent(job, label, 'running');

  const ensureNotCancelled = () => {
    if (job.cancelledBy) throw new Error(`cancelled by ${job.cancelledBy}`);
    throwIfAborted(signal);
    if (job.deadlineExceeded || (job.deadlineAt !== undefined && Date.now() >= job.deadlineAt)) {
      job.deadlineExceeded = true;
      throw new Error('job deadline exceeded');
    }
  };

  ensureNotCancelled();
  job.warnings = undefined;
  const health = await getDeviceHealth(device.id, true, signal);
  ensureNotCancelled();
  let currentAppStoreVersion: ItunesLookupResult | undefined;
  if (!job.testflight && !job.externalVersionId) {
    try {
      currentAppStoreVersion = await lookupCurrentVersion(job.bundleId, signal);
    } catch (err) {
      ensureNotCancelled();
      log.warn('could not resolve current App Store file size before install', { bundleId: job.bundleId, error: String(err) });
    }
  }
  ensureNotCancelled();
  const installBlocker = getDeviceInstallBlocker(health, job.testflight?.build.fileSize ?? currentAppStoreVersion?.fileSizeBytes);
  if (installBlocker) throw new Error(`decrypt deferred: ${installBlocker}`);
  const stagingDir = path.join(config.artifactDir, '.staging');
  await mkdir(stagingDir, { recursive: true });
  const outputPath = path.join(stagingDir, `${job.id}.ipa`);
  job.filePath = outputPath;
  job.deviceId = device.id;

  let lastActivityStage = '';
  const report = (message: string) => {
    job.progress = message;
    recordTimeline(message);
    const stage = /foreground/i.test(message)
      ? 'Foregrounding App Store'
      : /TestFlight is running/i.test(message)
        ? 'Foregrounding TestFlight'
        : /install/i.test(message)
          ? 'Installing app build'
          : /decrypt/i.test(message)
            ? 'Decrypting app bundle'
            : '';
    if (stage && stage !== lastActivityStage) {
      lastActivityStage = stage;
      recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: stage });
    }
    emitJobsChanged();
  };

  report(`autoinstall transaction ${job.id}`);

  if (job.testflight) {
    await installBuild(job.testflight.appId, job.testflight.build, report, undefined, job.id, undefined, device, signal);
  } else {
    const installed = await installFromAppStore(job.bundleId, {
      externalVersionId: job.externalVersionId,
      expectedVersion: job.externalVersionId ? job.versionLabel : undefined,
      operationId: buildAppStoreOperationId(job.id, job.retryCount ?? 0),
      onProgress: report,
      isCancelled: () => Boolean(job.cancelledBy || job.deadlineExceeded),
      currentVersion: currentAppStoreVersion,
      device,
      signal,
    });
    if (installed.shortVersion) job.versionLabel = installed.shortVersion;
  }

  ensureNotCancelled();

  recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypting app bundle' });

  await withIpadecrypt(device, async (rootDir) => {
    ensureNotCancelled();
    const args = ['--root-dir', rootDir, 'decrypt', job.bundleId, '--use-installed', '--output', outputPath];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(config.ipadecryptBin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
      job.childProcess = child;
      const abortChild = () => terminateChildProcess(child, 'SIGTERM');
      signal?.addEventListener('abort', abortChild, { once: true });
      if (signal?.aborted) abortChild();

      let output = '';

      const onOutput = (chunk: Buffer) => {
        const rawText = chunk.toString('utf8');
        output += rawText;
        const text = rawText.trim();
        if (!text) return;
        const lines = text.split('\n');
        const lastLine = lines.at(-1) ?? text;
        job.progress = lastLine;
        recordTimeline(lastLine);
        log.info('ipadecrypt output', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, line: lastLine });
        emitJobsChanged();
      };

      child.stdout.on('data', onOutput);
      child.stderr.on('data', onOutput);

      child.on('error', (err) => {
        signal?.removeEventListener('abort', abortChild);
        if (job.childProcess === child) job.childProcess = undefined;
        reject(err);
      });

      child.on('close', (code) => {
        signal?.removeEventListener('abort', abortChild);
        if (job.childProcess === child) job.childProcess = undefined;
        if (signal?.aborted) {
          reject(abortedOperationError(signal));
          return;
        }
        const result = classifyIpaDecryptOutput(output);
        if (job.cancelledBy) {
          reject(new Error(`cancelled by ${job.cancelledBy}`));
        } else if (result.extensionOnly) {
          job.warnings = result.warnings;
          for (const warning of result.warnings) appendJobTimelineEvent(job, `Warning: ${warning}`, 'done');
          log.warn('ipadecrypt completed with extension warnings', {
            jobId: job.id,
            bundleId: job.bundleId,
            deviceId: device.id,
            encryptedPaths: result.encryptedPaths,
          });
          emitJobsChanged();
          resolve();
        } else if (code === 0 && !result.error && result.encryptedPaths.length === 0) {
          resolve();
        } else {
          reject(new Error(result.error ?? `ipadecrypt exited with code ${code}: ${job.progress}`));
        }
      });
    });
  }, signal);

  ensureNotCancelled();
  const st = await stat(outputPath);
  job.fileSizeBytes = st.size;

  try {
    const metadata = await extractIpaMetadata(outputPath);
    job.ipaMetadata = metadata.summary;
    job.ipaInfoPlist = metadata.infoPlist;
  } catch (err) {
    log.warn('failed to extract IPA metadata', { jobId: job.id, bundleId: job.bundleId, error: String(err) });
  }

  ensureNotCancelled();
  const artifact = await promoteArtifact({
    key: artifactKeyForJob(job),
    bundleId: job.bundleId,
    channel: job.testflight ? 'testflight' : 'appstore',
    externalVersionId: job.externalVersionId,
    testflightBuildId: job.testflight?.build.id,
    versionLabel: job.ipaMetadata?.shortVersion ?? job.testflight?.build.cfBundleShortVersion ?? job.versionLabel,
    buildNumber: job.ipaMetadata?.bundleVersion ?? job.testflight?.build.cfBundleVersion,
    stagingPath: outputPath,
    sourceJobId: job.id,
    warnings: job.warnings,
    projectId: job.projectId,
    signal,
  });
  job.artifactId = artifact.id;
  job.filePath = artifact.filePath;
  job.fileSizeBytes = artifact.fileSizeBytes;
  job.sha256 = artifact.sha256;
}
