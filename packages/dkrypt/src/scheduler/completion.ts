import type { SchedulerRunOutcome, SchedulerRunStatus } from '#store/state.js';
import type { WorkflowRun } from '#scheduler/github.js';

export function workflowRunStatus(run: WorkflowRun): SchedulerRunStatus {
  if (run.status !== 'completed') return 'timed_out';
  return run.conclusion === 'success' ? 'succeeded' : 'failed';
}

export function aggregateWorkflowRunStatus(
  outcomes: Array<Partial<SchedulerRunOutcome>>,
  targetCount: number,
): SchedulerRunStatus {
  const succeeded = outcomes.filter((outcome) => outcome.runStatus === 'succeeded').length;
  if (succeeded === targetCount) return 'succeeded';

  const failed = outcomes.filter((outcome) => outcome.runStatus === 'failed').length;
  const timedOut = outcomes.filter((outcome) => outcome.runStatus === 'timed_out').length;
  if (timedOut > 0 || outcomes.length < targetCount) return 'timed_out';
  return failed > 0 ? 'failed' : 'timed_out';
}

export function selectWorkflowRunUrl(outcomes: Array<Partial<SchedulerRunOutcome>>): string | undefined {
  return outcomes.find((outcome) => outcome.runStatus === 'failed' && outcome.runUrl)?.runUrl
    ?? outcomes.find((outcome) => outcome.runStatus === 'timed_out' && outcome.runUrl)?.runUrl
    ?? outcomes.find((outcome) => outcome.runUrl)?.runUrl;
}
