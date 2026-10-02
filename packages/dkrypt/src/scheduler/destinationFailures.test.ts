import { expect, test } from 'bun:test';
import type { DispatchTarget } from '#store/state.js';
import { destinationFailures, summarizeDestinationFailures } from './destinationFailures.js';

const targets: DispatchTarget[] = [
  { repo: 'owner/working', ghWorkflowFile: 'update.yml' },
  { repo: 'owner/failing', ghWorkflowFile: 'update.yml' },
];

const checks = [
  { ok: true, reason: 'v2.0_20 not yet released - would dispatch' },
  { ok: false, reason: 'TestFlight trains lookup failed: device offline', failureClass: 'device_transport' as const },
];

test('retains lookup failures for destinations while allowing healthy destinations to proceed', () => {
  const failures = destinationFailures(targets, checks);

  expect(failures).toEqual([{ target: targets[1], check: checks[1] }]);
  expect(summarizeDestinationFailures(failures)).toBe('owner/failing: TestFlight trains lookup failed: device offline');
});

test('returns no failure summary when every destination check succeeds', () => {
  expect(summarizeDestinationFailures([])).toBeUndefined();
});

test('keeps every destination name when individual failure details are long', () => {
  const failures = [
    { target: targets[0]!, check: { ok: false, reason: 'a'.repeat(500) } },
    { target: targets[1]!, check: { ok: false, reason: 'b'.repeat(500) } },
  ];
  const summary = summarizeDestinationFailures(failures);

  expect(summary).toContain('owner/working');
  expect(summary).toContain('owner/failing');
  expect(summary?.split('...')).toHaveLength(3);
});
