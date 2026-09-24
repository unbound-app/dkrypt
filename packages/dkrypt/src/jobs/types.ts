import type { ChildProcess } from 'node:child_process';
import type { TFBuild } from '#testflight.js';
import type { IpaMetadata } from '#store/state.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export type JobSource = 'manual' | 'scheduler';

export type JobFailureClass = 'device_transport' | 'app_store' | 'testflight' | 'network' | 'storage' | 'decrypt' | 'cancelled' | 'unknown';

export interface TestFlightJobSource {
  appId: number;
  build: TFBuild;
}

export interface JobTimelineEvent {
  at: number;
  label: string;
  status: JobStatus;
}

export interface Job {
  id: string;
  correlationId?: string;
  bundleId: string;
  externalVersionId?: string;
  testflight?: TestFlightJobSource;
  versionLabel?: string;
  source: JobSource;
  queuedBy?: string;
  apiKeyId?: string;
  preferredDeviceId?: string;
  priority: number;
  status: JobStatus;
  progress: string;
  timeline?: JobTimelineEvent[];
  warnings?: string[];
  error?: string;
  retryCount?: number;
  attempt?: number;
  deadlineAt?: number;
  deadlineExceeded?: boolean;
  failureClass?: JobFailureClass;
  cancelledBy?: string;
  childProcess?: ChildProcess;
  artifactId?: string;
  cacheHit?: boolean;
  filePath?: string;
  fileSizeBytes?: number;
  sha256?: string;
  deviceId?: string;
  ipaMetadata?: IpaMetadata;
  ipaInfoPlist?: Record<string, unknown>;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  downloadedAt?: number;
  waiters: Array<(job: Job) => void>;
}

export function appendJobTimelineEvent(job: Job, label: string, status: JobStatus, at = Date.now()): void {
  const events = job.timeline ?? (job.timeline = []);
  if (events.at(-1)?.label === label) return;
  events.push({ at, label, status });
  if (events.length > 80) events.splice(0, events.length - 80);
}
