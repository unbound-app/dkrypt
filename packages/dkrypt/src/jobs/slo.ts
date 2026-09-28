import type { JobStatus } from '#jobs/types.js';

export interface JobDurationSample {
  status: JobStatus;
  projectId?: string;
  startedAt?: number;
  finishedAt: number;
}

export interface QueueServiceObjectiveInput {
  createdAt: number;
  now: number;
  status: JobStatus;
  queuePosition?: number;
  parallelism: number;
  objectiveMs: number;
  serviceDurationP95Ms: number | null;
}

export interface QueueServiceObjectiveAssessment {
  waitedMs: number;
  predictedStartMs: number | null;
  predictedCompletionMs: number | null;
  parallelism: number;
  objective: 'within' | 'breached';
}

export function queueServiceObjectiveMs(minutes: number): number {
  return Math.max(1, Math.trunc(minutes)) * 60_000;
}

export function completedJobDurationP95Ms(samples: readonly JobDurationSample[]): number | null {
  const durations = samples
    .flatMap((sample) => {
      const startedAt = sample.startedAt;
      if (sample.status !== 'done' || typeof startedAt !== 'number' || sample.finishedAt <= startedAt) return [];
      return [sample.finishedAt - startedAt];
    })
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  return durations[Math.ceil(durations.length * 0.95) - 1] ?? null;
}

export function projectCompletedJobDurationP95Ms(
  samples: readonly JobDurationSample[],
  projectId: string,
  defaultProjectId: string,
): number | null {
  return completedJobDurationP95Ms(samples.filter((sample) => (sample.projectId ?? defaultProjectId) === projectId));
}

export function assessQueueServiceObjective(input: QueueServiceObjectiveInput): QueueServiceObjectiveAssessment {
  const waitedMs = Math.max(0, input.now - input.createdAt);
  const parallelism = Math.max(0, Math.trunc(input.parallelism));
  const predictedStartMs = input.status === 'queued'
    && input.queuePosition !== undefined
    && parallelism > 0
    && input.serviceDurationP95Ms !== null
    ? Math.floor(Math.max(0, input.queuePosition - 1) / parallelism) * input.serviceDurationP95Ms
    : null;
  const predictedCompletionMs = predictedStartMs === null || input.serviceDurationP95Ms === null
    ? null
    : predictedStartMs + input.serviceDurationP95Ms;
  const objective = waitedMs > input.objectiveMs
    || (predictedCompletionMs !== null && waitedMs + predictedCompletionMs > input.objectiveMs)
    ? 'breached'
    : 'within';
  return { waitedMs, predictedStartMs, predictedCompletionMs, parallelism, objective };
}

export function queueServiceObjectiveBreachDescription(
  bundleId: string,
  assessment: QueueServiceObjectiveAssessment,
  objectiveMs: number,
): string {
  const activeMinutes = Math.max(0, Math.round(assessment.waitedMs / 60_000));
  const objectiveMinutes = Math.max(1, Math.round(objectiveMs / 60_000));
  const elapsedUnit = activeMinutes === 1 ? 'minute' : 'minutes';
  const elapsedMessage = `is still unfinished after ${activeMinutes} ${elapsedUnit}`;
  const breachMessage = assessment.waitedMs > objectiveMs
    ? `has missed the ${objectiveMinutes}-minute completion objective`
    : `is projected to miss the ${objectiveMinutes}-minute completion objective`;
  return `${bundleId} ${elapsedMessage} and ${breachMessage}.`;
}
