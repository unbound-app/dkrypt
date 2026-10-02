import { expect, test } from 'bun:test';
import { checkDestinationsWithRetries, classifySchedulerFailure, runWithSchedulerRetries } from './failure.js';

test('classifies transient device-agent failures as retryable transport errors', () => {
  const failure = classifySchedulerFailure(new Error('DeviceAgentUnavailableError: could not connect to the dkrypt device agent'));

  expect(failure).toEqual({ failureClass: 'device_transport', retryable: true });
});

test('respects explicit non-retryable bridge errors through wrapper causes', () => {
  const bridgeError = Object.assign(new Error('unsupported'), { details: { retryable: false } });
  const wrapped = new Error('TestFlight trains lookup failed', { cause: bridgeError });

  expect(classifySchedulerFailure(wrapped)).toEqual({ failureClass: 'testflight', retryable: false });
});

test('classifies wrapped device-agent causes instead of only their TestFlight context', () => {
  const bridgeFailure = Object.assign(new Error('could not connect to the dkrypt device agent'), { retryable: true });
  const wrapped = new Error('TestFlight trains lookup failed', { cause: bridgeFailure });

  expect(classifySchedulerFailure(wrapped)).toEqual({ failureClass: 'device_transport', retryable: true });
});

test('does not retry an HTTP client error', () => {
  expect(classifySchedulerFailure(new Error('Failed to verify releases: HTTP 404'))).toEqual({ failureClass: 'network', retryable: false });
  expect(classifySchedulerFailure(new Error('iTunes lookup failed: HTTP 404'))).toEqual({ failureClass: 'app_store', retryable: false });
});

test('retries HTTP request timeouts and rate limits', () => {
  expect(classifySchedulerFailure(new Error('TestFlight lookup failed: HTTP 408'))).toEqual({ failureClass: 'testflight', retryable: true });
  expect(classifySchedulerFailure(new Error('TestFlight lookup failed: HTTP 429'))).toEqual({ failureClass: 'testflight', retryable: true });
  expect(classifySchedulerFailure(new Error('GitHub API returned HTTP 403: API rate limit exceeded'))).toEqual({ failureClass: 'network', retryable: true });
  expect(classifySchedulerFailure(new Error('GitHub API rate limit exceeded'))).toEqual({ failureClass: 'network', retryable: true });
  expect(classifySchedulerFailure(new Error('GitHub API returned HTTP 403: resource forbidden'))).toEqual({ failureClass: 'network', retryable: false });
});

test('retries retryable scheduler failures and stops on non-retryable failures', async () => {
  let calls = 0;
  const delays: number[] = [];
  const outcomes = [
    { ok: false, retryable: true, reason: 'temporary network timeout' },
    { ok: false, retryable: false, reason: 'HTTP 404' },
  ];

  const result = await runWithSchedulerRetries(
    async () => outcomes[calls++]!,
    3,
    async (delayMs) => { delays.push(delayMs); },
    () => undefined,
    () => undefined,
  );

  expect(calls).toBe(2);
  expect(delays).toEqual([30_000]);
  expect(result.reason).toBe('HTTP 404');
});

test('retries only the failing destination when other destinations are healthy', async () => {
  const calls = new Map<string, number>();
  const retries: string[] = [];
  const results = await checkDestinationsWithRetries(
    ['healthy', 'transient'],
    async (target) => {
      const callCount = (calls.get(target) ?? 0) + 1;
      calls.set(target, callCount);
      if (target === 'transient' && callCount === 1) return { ok: false, reason: 'HTTP 503', retryable: true };
      return { ok: true, reason: 'ready' };
    },
    2,
    async () => undefined,
    (target) => { retries.push(target); },
    () => undefined,
  );

  expect(calls).toEqual(new Map([['healthy', 1], ['transient', 2]]));
  expect(retries).toEqual(['transient']);
  expect(results.map(({ ok }) => ok)).toEqual([true, true]);
});
