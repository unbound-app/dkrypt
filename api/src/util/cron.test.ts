import { describe, expect, test } from 'bun:test';
import { nextCronRunAt } from './cron.js';

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
});
