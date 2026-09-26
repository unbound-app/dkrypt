import type { LogEntry } from '#logger.js';
import { getActiveJobs, getJob } from '#jobs/store.js';
import { DEFAULT_PROJECT_ID, getAllJobHistory, getJobHistoryEntryById } from '#store/state.js';

export function logBelongsToProject(entry: LogEntry, projectId: string): boolean {
  const explicitProjectId = typeof entry.meta?.projectId === 'string' ? entry.meta.projectId : undefined;
  if (explicitProjectId) return explicitProjectId === projectId;
  const jobId = typeof entry.meta?.jobId === 'string' ? entry.meta.jobId : undefined;
  const correlationId = typeof entry.meta?.correlationId === 'string' ? entry.meta.correlationId : undefined;
  const activeJob = jobId
    ? getJob(jobId)
    : correlationId
      ? getActiveJobs().find((job) => job.correlationId === correlationId)
      : undefined;
  const historyEntry = jobId
    ? getJobHistoryEntryById(jobId)
    : correlationId
      ? getAllJobHistory().find((job) => job.correlationId === correlationId)
      : undefined;
  const relatedProjectId = activeJob?.projectId ?? historyEntry?.projectId;
  if (relatedProjectId) return relatedProjectId === projectId;
  return projectId === DEFAULT_PROJECT_ID && !jobId && !correlationId;
}
