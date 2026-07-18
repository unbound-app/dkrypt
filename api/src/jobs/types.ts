import type { ChildProcess } from 'node:child_process';
import type { TFBuild } from '../testflight.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type JobSource = 'manual' | 'scheduler';

export interface TestFlightJobSource {
  appId: number;
  build: TFBuild;
}

export interface Job {
  id: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  source: JobSource;
  queuedBy?: string;
  priority: number;
  status: JobStatus;
  progress: string;
  error?: string;
  cancelledBy?: string;
  childProcess?: ChildProcess;
  filePath?: string;
  fileSizeBytes?: number;
  deviceId?: string;
  ipaMetadata?: { bundleVersion?: string; shortVersion?: string; minOsVersion?: string; executable?: string };
  ipaInfoPlist?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  downloadedAt?: number;
  waiters: Array<(job: Job) => void>;
}
