import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
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
import { artifactKeyForJob, promoteArtifact } from '#artifacts.js';

const log = scopedLogger('jobs');
import { appendJobTimelineEvent, type Job } from '#jobs/types.js';

export async function runDecrypt(job: Job, device: DeviceRecord): Promise<void> {
  const recordTimeline = (label: string) => appendJobTimelineEvent(job, label, 'running');

  const ensureNotCancelled = () => {
    if (job.cancelledBy) throw new Error(`cancelled by ${job.cancelledBy}`);
  };

  ensureNotCancelled();
  const health = await getDeviceHealth(device.id, true);
  let currentAppStoreVersion: ItunesLookupResult | undefined;
  if (!job.testflight && !job.externalVersionId) {
    try {
      currentAppStoreVersion = await lookupCurrentVersion(job.bundleId);
    } catch (err) {
      log.warn('could not resolve current App Store file size before install', { bundleId: job.bundleId, error: String(err) });
    }
  }
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
    await installBuild(job.testflight.appId, job.testflight.build, report, undefined, job.id);
  } else {
    const installed = await installFromAppStore(job.bundleId, {
      externalVersionId: job.externalVersionId,
      expectedVersion: job.externalVersionId ? job.versionLabel : undefined,
      operationId: buildAppStoreOperationId(job.id, job.retryCount ?? 0),
      onProgress: report,
      isCancelled: () => Boolean(job.cancelledBy),
      currentVersion: currentAppStoreVersion,
    });
    if (installed.shortVersion) job.versionLabel = installed.shortVersion;
  }

  ensureNotCancelled();

  const args = ['--root-dir', device.rootDir, 'decrypt', job.bundleId, '--use-installed', '--output', outputPath];
  recordDeviceActivity({ deviceId: device.id, kind: 'job', bundleId: job.bundleId, message: 'Decrypting app bundle' });

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.ipadecryptBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.childProcess = child;

    let lastErrorLine: string | undefined;

    const onLine = (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      const lines = text.split('\n');
      const lastLine = lines.at(-1) ?? text;
      job.progress = lastLine;
      recordTimeline(lastLine);
      for (const line of lines) {
        if (line.trimStart().startsWith('[err]')) lastErrorLine = line.trim();
      }
      log.info('ipadecrypt output', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, line: lastLine });
      emitJobsChanged();
    };

    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      job.childProcess = undefined;
      if (code === 0 && !lastErrorLine) {
        resolve();
      } else if (job.cancelledBy) {
        reject(new Error(`cancelled by ${job.cancelledBy}`));
      } else {
        reject(new Error(lastErrorLine ?? `ipadecrypt exited with code ${code}: ${job.progress}`));
      }
    });
  });

  const st = await stat(outputPath);
  job.fileSizeBytes = st.size;

  try {
    const metadata = await extractIpaMetadata(outputPath);
    job.ipaMetadata = metadata.summary;
    job.ipaInfoPlist = metadata.infoPlist;
  } catch (err) {
    log.warn('failed to extract IPA metadata', { jobId: job.id, bundleId: job.bundleId, error: String(err) });
  }

  const artifact = await promoteArtifact({
    key: artifactKeyForJob(job),
    bundleId: job.bundleId,
    channel: job.testflight ? 'testflight' : 'appstore',
    externalVersionId: job.externalVersionId,
    testflightBuildId: job.testflight?.build.id,
    versionLabel: job.versionLabel,
    buildNumber: job.testflight?.build.cfBundleVersion,
    stagingPath: outputPath,
    sourceJobId: job.id,
  });
  job.artifactId = artifact.id;
  job.filePath = artifact.filePath;
  job.fileSizeBytes = artifact.fileSizeBytes;
  job.sha256 = artifact.sha256;
}
