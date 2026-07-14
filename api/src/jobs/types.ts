export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  bundleId: string;
  status: JobStatus;
  /** Last line emitted by the ipadecrypt CLI, surfaced for polling clients. */
  progress: string;
  error?: string;
  filePath?: string;
  fileSizeBytes?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set once the file has been streamed out fully; lets the sweeper reclaim it faster. */
  downloadedAt?: number;
  /** Who is waiting on this job to finish (resolved with the same Job object on completion). */
  waiters: Array<(job: Job) => void>;
}
