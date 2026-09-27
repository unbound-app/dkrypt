import { describe, expect, test } from 'bun:test';
import { isValidMaintenanceWindow, isWithinMaintenanceWindow, maintenanceWindowEndAt } from '#util/maintenanceWindow.js';

describe('maintenance windows', () => {
  test('requires different valid local start and end times', () => {
    expect(isValidMaintenanceWindow({ start: '22:00', end: '06:00' })).toBe(true);
    expect(isValidMaintenanceWindow({ start: '06:00', end: '06:00' })).toBe(false);
    expect(isValidMaintenanceWindow({ start: '24:00', end: '06:00' })).toBe(false);
  });

  test('ends a daily quiet window at its local end time across an autumn clock change', () => {
    expect(maintenanceWindowEndAt(
      { start: '08:00', end: '10:00' },
      'Europe/Berlin',
      Date.parse('2026-10-25T08:00:00.000Z'),
    )).toBe(Date.parse('2026-10-25T09:00:00.000Z'));
  });

  test('ends overnight quiet hours on the next local day across a clock change', () => {
    expect(maintenanceWindowEndAt(
      { start: '22:00', end: '06:00' },
      'Europe/Berlin',
      Date.parse('2026-10-24T21:00:00.000Z'),
    )).toBe(Date.parse('2026-10-25T05:00:00.000Z'));
  });

  test('closes at the first valid local minute when the end time falls inside a daylight-saving gap', () => {
    expect(maintenanceWindowEndAt(
      { start: '01:00', end: '02:30' },
      'Europe/Berlin',
      Date.parse('2026-03-29T00:30:00.000Z'),
    )).toBe(Date.parse('2026-03-29T01:00:00.000Z'));
  });

  test('uses the repeated local end time that still lies ahead after the autumn clock change', () => {
    const window = { start: '02:00', end: '02:30' };
    const secondOccurrence = Date.parse('2026-10-25T01:10:00.000Z');

    expect(isWithinMaintenanceWindow(window, 'Europe/Berlin', secondOccurrence)).toBe(true);
    expect(maintenanceWindowEndAt(window, 'Europe/Berlin', secondOccurrence)).toBe(Date.parse('2026-10-25T01:30:00.000Z'));
  });
});
