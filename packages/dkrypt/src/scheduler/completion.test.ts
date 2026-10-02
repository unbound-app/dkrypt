import { describe, expect, test } from 'bun:test';
import { aggregateWorkflowRunStatus, workflowRunStatus } from '#scheduler/completion.js';

test('workflow run status distinguishes an incomplete poll from a failed workflow', () => {
  expect(workflowRunStatus({ id: 1, status: 'in_progress', conclusion: null, created_at: '', html_url: '' })).toBe('timed_out');
  expect(workflowRunStatus({ id: 2, status: 'completed', conclusion: 'failure', created_at: '', html_url: '' })).toBe('failed');
  expect(workflowRunStatus({ id: 3, status: 'completed', conclusion: 'success', created_at: '', html_url: '' })).toBe('succeeded');
});

describe('aggregate workflow run status', () => {
  test('reports success only when every dispatch target succeeds', () => {
    expect(aggregateWorkflowRunStatus([{ runStatus: 'succeeded' }, { runStatus: 'succeeded' }], 2)).toBe('succeeded');
  });

  test('reports failure for completed mixed success and failure outcomes', () => {
    expect(aggregateWorkflowRunStatus([{ runStatus: 'succeeded' }, { runStatus: 'failed' }], 2)).toBe('failed');
  });

  test('reports timeout when any target is incomplete or times out', () => {
    expect(aggregateWorkflowRunStatus([{ runStatus: 'succeeded' }, { runStatus: 'timed_out' }], 2)).toBe('timed_out');
    expect(aggregateWorkflowRunStatus([{ runStatus: 'succeeded' }], 2)).toBe('timed_out');
  });

  test('reports failure when all completed targets fail', () => {
    expect(aggregateWorkflowRunStatus([{ runStatus: 'failed' }, { runStatus: 'failed' }], 2)).toBe('failed');
  });
});
