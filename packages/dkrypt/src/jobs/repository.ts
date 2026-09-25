import { config } from '#config.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollections } from '#store/sqlite.js';

type StoredJob = Omit<Job, 'childProcess' | 'waiters'>;

const database = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['jobs', 'job_timelines']);

function serializableJob(job: Job): StoredJob {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

export function loadPersistedJobs(): StoredJob[] {
  const rows = readStateCollection(database, 'jobs');
  const timelines = new Map<string, unknown>();
  for (const value of readStateCollection(database, 'job_timelines')) {
    if (typeof value !== 'object' || value === null || typeof (value as { jobId?: unknown }).jobId !== 'string') throw new Error('persisted job timeline record is malformed');
    timelines.set((value as { jobId: string }).jobId, (value as { events?: unknown }).events);
  }
  const jobs: StoredJob[] = [];
  for (const value of rows) {
    if (typeof value !== 'object' || value === null) throw new Error('persisted job record is malformed');
    const job = value as StoredJob;
    if (typeof job.id !== 'string' || !['queued', 'running', 'done', 'failed'].includes(job.status)) throw new Error('persisted job record is malformed');
    const timeline = timelines.get(job.id);
    jobs.push(Array.isArray(timeline) && !job.timeline ? { ...job, timeline: timeline as Job['timeline'] } : job);
  }
  return jobs;
}

export function replacePersistedJobs(jobs: Iterable<Job>): void {
  const values = [...jobs];
  replaceStateCollections(database, [
    { table: 'jobs', rows: values.map((job) => ({ id: job.id, payload: serializableJob(job), updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
    { table: 'job_timelines', rows: values.map((job) => ({ id: job.id, payload: { jobId: job.id, events: job.timeline ?? [] }, updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
  ]);
}

export function closePersistedJobs(): void {
  database.close();
}
