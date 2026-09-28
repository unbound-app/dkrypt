import { expect, test } from 'bun:test';
import { assessQueueServiceObjective, completedJobDurationP95Ms, projectCompletedJobDurationP95Ms, queueServiceObjectiveBreachDescription, queueServiceObjectiveMs } from '#jobs/slo.js';

test('queue objective stays fixed while historical decrypt duration estimates service time', () => {
  const objectiveMs = queueServiceObjectiveMs(5);
  const assessment = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 1_000,
    status: 'queued',
    queuePosition: 1,
    parallelism: 1,
    objectiveMs,
    serviceDurationP95Ms: 10_000,
  });

  expect(objectiveMs).toBe(300_000);
  expect(assessment).toEqual({
    waitedMs: 0,
    predictedStartMs: 0,
    predictedCompletionMs: 10_000,
    parallelism: 1,
    objective: 'within',
  });
});

test('queue objective predicts completion from work ahead of the job', () => {
  const assessment = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 71_000,
    status: 'queued',
    queuePosition: 2,
    parallelism: 1,
    objectiveMs: queueServiceObjectiveMs(5),
    serviceDurationP95Ms: 120_000,
  });

  expect(assessment).toEqual({
    waitedMs: 70_000,
    predictedStartMs: 120_000,
    predictedCompletionMs: 240_000,
    parallelism: 1,
    objective: 'breached',
  });
});

test('running jobs without a queue position breach only after the fixed objective elapses', () => {
  const objectiveMs = queueServiceObjectiveMs(5);
  const within = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 299_000,
    status: 'running',
    parallelism: 1,
    objectiveMs,
    serviceDurationP95Ms: 120_000,
  });
  const breached = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 301_001,
    status: 'running',
    parallelism: 1,
    objectiveMs,
    serviceDurationP95Ms: 120_000,
  });

  expect(within.objective).toBe('within');
  expect(breached.objective).toBe('breached');
});

test('queue forecasts account for multiple devices running jobs concurrently', () => {
  const assessment = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 2_000,
    status: 'queued',
    queuePosition: 3,
    parallelism: 2,
    objectiveMs: queueServiceObjectiveMs(5),
    serviceDurationP95Ms: 120_000,
  });

  expect(assessment).toEqual({
    waitedMs: 1_000,
    predictedStartMs: 120_000,
    predictedCompletionMs: 240_000,
    parallelism: 2,
    objective: 'within',
  });
});

test('queue forecasts are omitted when there are no compatible enabled devices', () => {
  const assessment = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 2_000,
    status: 'queued',
    queuePosition: 3,
    parallelism: 0,
    objectiveMs: queueServiceObjectiveMs(5),
    serviceDurationP95Ms: 120_000,
  });

  expect(assessment.predictedStartMs).toBeNull();
  expect(assessment.predictedCompletionMs).toBeNull();
  expect(assessment.objective).toBe('within');
});

test('historical P95 uses successful positive job durations only', () => {
  expect(completedJobDurationP95Ms([
    { status: 'done', startedAt: 1, finishedAt: 11 },
    { status: 'done', startedAt: 20, finishedAt: 40 },
    { status: 'failed', startedAt: 50, finishedAt: 1_000 },
    { status: 'done', startedAt: 60, finishedAt: 60 },
    { status: 'done', finishedAt: 5_000 },
  ])).toBe(20);
  expect(completedJobDurationP95Ms([])).toBeNull();
});

test('project service-time P95 excludes history from other projects and scopes legacy jobs to the default', () => {
  const samples = [
    { projectId: 'default', status: 'done' as const, startedAt: 1, finishedAt: 11 },
    { projectId: 'other', status: 'done' as const, startedAt: 1, finishedAt: 1_001 },
    { status: 'done' as const, startedAt: 1, finishedAt: 21 },
  ];

  expect(projectCompletedJobDurationP95Ms(samples, 'default', 'default')).toBe(20);
  expect(projectCompletedJobDurationP95Ms(samples, 'other', 'default')).toBe(1_000);
});

test('breach descriptions distinguish elapsed misses from projected misses', () => {
  const objectiveMs = queueServiceObjectiveMs(5);
  const projected = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 71_000,
    status: 'queued',
    queuePosition: 2,
    parallelism: 1,
    objectiveMs,
    serviceDurationP95Ms: 120_000,
  });
  const elapsed = assessQueueServiceObjective({
    createdAt: 1_000,
    now: 302_000,
    status: 'running',
    parallelism: 1,
    objectiveMs,
    serviceDurationP95Ms: 120_000,
  });

  expect(queueServiceObjectiveBreachDescription('com.example.app', projected, objectiveMs)).toContain('is still unfinished after 1 minute and is projected to miss');
  expect(queueServiceObjectiveBreachDescription('com.example.app', elapsed, objectiveMs)).toContain('is still unfinished after 5 minutes and has missed');
});
