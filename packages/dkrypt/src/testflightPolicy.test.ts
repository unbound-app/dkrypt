import { expect, test } from 'bun:test';
import { isTestFlightVerificationFresh, TESTFLIGHT_VERIFICATION_TTL_MS } from '#testflightPolicy.js';

test('TestFlight verification freshness enforces the time limit and rejects invalid timestamps', () => {
  const now = 100_000_000;

  expect(isTestFlightVerificationFresh(now - TESTFLIGHT_VERIFICATION_TTL_MS, now)).toBe(true);
  expect(isTestFlightVerificationFresh(now - TESTFLIGHT_VERIFICATION_TTL_MS - 1, now)).toBe(false);
  expect(isTestFlightVerificationFresh(now + 1, now)).toBe(false);
  expect(isTestFlightVerificationFresh(Number.NaN, now)).toBe(false);
  expect(isTestFlightVerificationFresh(undefined, now)).toBe(false);
});
