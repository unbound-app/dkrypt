import { config } from '#config.js';
import type { Job } from '#jobs/types.js';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollections } from '#store/sqlite.js';
import type { Database } from 'bun:sqlite';

type StoredJob = Omit<Job, 'childProcess' | 'waiters'>;

export interface JobBuildLookup {
  projectId: string;
  bundleId: string;
  externalVersionId?: string;
  testFlightBuildId?: number;
}

export interface JobRepository {
  load(): StoredJob[];
  replace(jobs: Iterable<Job>): void;
  findActiveId(lookup: JobBuildLookup): string | undefined;
  findReusableCompletedIds(lookup: JobBuildLookup): string[];
  close(): void;
}

function serializableJob(job: Job): StoredJob {
  const { childProcess: _childProcess, waiters: _waiters, ...rest } = job;
  return rest;
}

function loadJobs(database: Database): StoredJob[] {
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

function replaceJobs(database: Database, jobs: Iterable<Job>): void {
  const values = [...jobs];
  replaceStateCollections(database, [
    { table: 'jobs', rows: values.map((job) => ({ id: job.id, payload: serializableJob(job), updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
    { table: 'job_timelines', rows: values.map((job) => ({ id: job.id, payload: { jobId: job.id, events: job.timeline ?? [] }, updatedAt: job.finishedAt ?? job.startedAt ?? job.createdAt })) },
  ]);
}

export function createJobRepository(database: Database): JobRepository {
  return {
    load: () => loadJobs(database),
    replace: (jobs) => replaceJobs(database, jobs),
    findActiveId(lookup) {
      const row = database.query(`
        SELECT id
        FROM jobs
        WHERE project_id = ?
          AND bundle_id = ?
          AND external_version_id IS ?
          AND testflight_build_id IS ?
          AND status IN ('queued', 'running')
        ORDER BY updated_at DESC
        LIMIT 1;
      `).get(lookup.projectId, lookup.bundleId, lookup.externalVersionId ?? null, lookup.testFlightBuildId ?? null) as { id?: string } | null;
      return row?.id;
    },
    findReusableCompletedIds(lookup) {
      const rows = database.query(`
        SELECT id
        FROM jobs
        WHERE project_id = ?
          AND bundle_id = ?
          AND external_version_id IS ?
          AND testflight_build_id IS ?
          AND status = 'done'
          AND file_path IS NOT NULL
          AND file_path != ''
        ORDER BY updated_at DESC;
      `).all(lookup.projectId, lookup.bundleId, lookup.externalVersionId ?? null, lookup.testFlightBuildId ?? null) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    },
    close: () => database.close(),
  };
}

const repository = createJobRepository(openStateCollectionDatabase(
  { stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs },
  ['jobs', 'job_timelines'],
));

export function loadPersistedJobs(): StoredJob[] {
  return repository.load();
}

export function replacePersistedJobs(jobs: Iterable<Job>): void {
  repository.replace(jobs);
}

export function findPersistedActiveJobId(lookup: JobBuildLookup): string | undefined {
  return repository.findActiveId(lookup);
}

export function findPersistedReusableCompletedJobIds(lookup: JobBuildLookup): string[] {
  return repository.findReusableCompletedIds(lookup);
}

export function closePersistedJobs(): void {
  repository.close();
}
