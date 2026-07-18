import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { emitJobsChanged } from '../events.js';
import { scopedLogger } from '../logger.js';
import type { DeviceRecord } from '../store/state.js';
import { installBuild } from '../testflight.js';
import { extractIpaMetadata } from '../util/ipaMetadata.js';

const log = scopedLogger('jobs');
import type { Job } from './types.js';

export async function runDecrypt(job: Job, device: DeviceRecord): Promise<void> {
  await mkdir(config.outputDir, { recursive: true });
  const outputPath = path.join(config.outputDir, `${job.id}.ipa`);
  job.filePath = outputPath;
  job.deviceId = device.id;

  if (job.testflight) {
    await installBuild(job.testflight.appId, job.testflight.build, (message) => {
      job.progress = message;
      emitJobsChanged();
    });
  }

  const args = ['--root-dir', device.rootDir, 'decrypt', job.bundleId];
  args.push(...(job.testflight ? ['--use-installed'] : ['--from-appstore']));
  args.push('--output', outputPath);
  if (job.externalVersionId) args.push('--external-version-id', job.externalVersionId);

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.ipadecryptBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.childProcess = child;

    const onLine = (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (!text) return;
      const lastLine = text.split('\n').at(-1) ?? text;
      job.progress = lastLine;
      log.info('ipadecrypt output', { jobId: job.id, bundleId: job.bundleId, deviceId: device.id, line: lastLine });
      emitJobsChanged();
    };

    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      job.childProcess = undefined;
      if (code === 0) {
        resolve();
      } else if (job.cancelledBy) {
        reject(new Error(`cancelled by ${job.cancelledBy}`));
      } else {
        reject(new Error(`ipadecrypt exited with code ${code}: ${job.progress}`));
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
}
