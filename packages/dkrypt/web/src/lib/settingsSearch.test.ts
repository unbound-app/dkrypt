import { describe, expect, test } from 'bun:test';
import { searchSettings, type SettingsSearchItem } from './settingsSearch';

const entries: SettingsSearchItem[] = [
  { id: 'devices', title: 'Devices', description: 'Pair and inspect devices', tab: 'settings', subtab: 'devices' },
  { id: 'billing', title: 'Billing', description: 'Payment provider settings', tab: 'settings', subtab: 'billing' },
];

describe('settings search', () => {
  test('matches labels and descriptions without exposing entries outside the supplied permission-filtered set', () => {
    expect(searchSettings(entries, 'payment')).toEqual([entries[1]]);
    expect(searchSettings([entries[0]!], 'payment')).toEqual([]);
  });

  test('returns no results for an empty query and trims surrounding whitespace', () => {
    expect(searchSettings(entries, '  ')).toEqual([]);
    expect(searchSettings(entries, ' devices ')).toEqual([entries[0]]);
  });
});
