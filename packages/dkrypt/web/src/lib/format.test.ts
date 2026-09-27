import { describe, expect, test } from 'bun:test';
import { fmtCalendarDate, fmtDateTime, fmtTime } from './format';

describe('localized time formatting', () => {
  test('includes the selected timezone in full timestamps', () => {
    const timestamp = Date.parse('2026-09-27T00:30:00.000Z');
    const expected = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: 'Europe/Berlin',
    }).format(new Date(timestamp));

    expect(fmtDateTime(timestamp, { timeZone: 'Europe/Berlin' })).toBe(expected);
    expect(fmtDateTime(timestamp, { timeZone: 'America/Los_Angeles' })).not.toBe(expected);
    const localZone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
      .formatToParts(new Date(timestamp))
      .find((part) => part.type === 'timeZoneName')?.value;
    expect(localZone).toBeDefined();
    expect(fmtTime(timestamp)).toContain(localZone!);
  });

  test('keeps date-only values on their declared calendar day', () => {
    const expected = new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date('2026-09-27T00:00:00.000Z'));

    expect(fmtCalendarDate('2026-09-27', { month: 'long', day: 'numeric' })).toBe(expected);
  });

  test('falls back safely for missing and invalid timestamps', () => {
    expect(fmtTime()).toBe('-');
    expect(fmtDateTime('not a timestamp')).toBe('-');
    expect(fmtCalendarDate('not a date')).toBe('-');
  });
});
