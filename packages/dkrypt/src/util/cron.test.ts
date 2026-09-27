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

  test('keeps the scheduled local hour across daylight-saving transitions', () => {
    const start = Date.parse('2026-03-28T08:00:00.000Z');
    const until = Date.parse('2026-03-30T08:00:00.000Z');

    expect(nextCronRuns('0 9 * * *', until, start, 10, 'Europe/Berlin')).toEqual([
      Date.parse('2026-03-29T07:00:00.000Z'),
      Date.parse('2026-03-30T07:00:00.000Z'),
    ]);
  });

  test('returns no runs for an unsupported timezone', () => {
    const start = Date.parse('2026-03-28T08:00:00.000Z');

    expect(nextCronRuns('0 9 * * *', start + 24 * 60 * 60 * 1000, start, 10, 'Mars/Olympus_Mons')).toEqual([]);
  });

  test('caps calendar runs', () => {
    const start = Date.parse('2026-07-28T10:00:00.000Z');
    expect(nextCronRuns('* * * * *', start + 60 * 60 * 1000, start, 3)).toHaveLength(3);
  });
});
