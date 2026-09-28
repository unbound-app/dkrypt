import { describe, expect, test } from 'bun:test';
import { fmtCalendarDate, fmtCountdown, fmtCurrency, fmtDateTime, fmtNumber, fmtRelative, fmtSize, fmtTime, fmtUntil } from './format';

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

  test('formats dates and relative times in the selected locale', () => {
    const timestamp = Date.parse('2026-09-27T00:30:00.000Z');
    const expectedDate = new Intl.DateTimeFormat('de-DE', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone: 'Europe/Berlin',
    }).format(new Date(timestamp));
    const expectedRelative = new Intl.RelativeTimeFormat('de-DE', { numeric: 'auto', style: 'short' }).format(-5, 'minute');

    expect(fmtDateTime(timestamp, { timeZone: 'Europe/Berlin' }, 'de-DE')).toBe(expectedDate);
    expect(fmtRelative(Date.now() - 5 * 60_000, 'de-DE')).toBe(expectedRelative);
  });

  test('localizes common numeric and expiry labels', () => {
    expect(fmtSize(1.5 * 1024 * 1024, 'de-DE')).toBe('1,5 MB');
    expect(fmtUntil(Date.now() - 1, 'de-DE')).toBe('abgelaufen');
    expect(fmtUntil(Date.now() + 24 * 60 * 60_000, 'de-DE')).toBe('1 Tag');
    expect(fmtCurrency(5, 'EUR', 'de-DE')).toBe('5,00 €');
    expect(fmtNumber(1234.5, 'de-DE', 1, 1)).toBe('1.234,5');
    expect(fmtCountdown(12_000, 'ar-EG')).toBe(`${new Intl.NumberFormat('ar-EG').format(12)}s`);
  });

  test('falls back safely for missing and invalid timestamps', () => {
    expect(fmtTime()).toBe('-');
    expect(fmtDateTime('not a timestamp')).toBe('-');
    expect(fmtCalendarDate('not a date')).toBe('-');
  });
});
