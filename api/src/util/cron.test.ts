import { describe, expect, test } from 'bun:test';
import { nextCronRunAt, nextCronRuns } from '#util/cron.js';

describe('nextCronRunAt', () => {
  test('returns a future timestamp for a valid expression', () => {
    const next = nextCronRunAt('0 * * * *');
    expect(next).toBeGreaterThan(Date.now());
  });

  test('returns undefined for an invalid expression', () => {
    expect(nextCronRunAt('not a cron expression')).toBeUndefined();
  });

  test('returns undefined for an empty expression', () => {
    expect(nextCronRunAt('')).toBeUndefined();
  });

  test('lists only runs inside the requested calendar window', () => {
    const start = Date.parse('2026-07-28T10:00:00.000Z');
    expect(nextCronRuns('0 * * * *', start + 3 * 60 * 60 * 1000, start)).toEqual([
      Date.parse('2026-07-28T11:00:00.000Z'),
      Date.parse('2026-07-28T12:00:00.000Z'),
      Date.parse('2026-07-28T13:00:00.000Z'),
    ]);
  });

  test('caps calendar runs', () => {
    const start = Date.parse('2026-07-28T10:00:00.000Z');
    expect(nextCronRuns('* * * * *', start + 60 * 60 * 1000, start, 3)).toHaveLength(3);
  });
});
