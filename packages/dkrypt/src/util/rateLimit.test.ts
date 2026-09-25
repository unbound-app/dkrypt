import { expect, test } from 'bun:test';
import { FixedWindowRateLimiter } from '#util/rateLimit.js';

test('fixed-window rate limiter exposes bounded retry metadata', () => {
  const limiter = new FixedWindowRateLimiter(2, 60_000);
  expect(limiter.consume('client', 1_000)).toMatchObject({ allowed: true, remaining: 1, resetAt: 61_000 });
  expect(limiter.consume('client', 2_000)).toMatchObject({ allowed: true, remaining: 0, resetAt: 61_000 });
  expect(limiter.consume('client', 3_000)).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 58, resetAt: 61_000 });
  expect(limiter.consume('client', 61_001)).toMatchObject({ allowed: true, remaining: 1, resetAt: 121_001 });
});
