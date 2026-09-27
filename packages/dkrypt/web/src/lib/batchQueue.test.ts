import { describe, expect, test } from 'bun:test';
import { getRecentlyVerifiedTestFlightDevices, parseBatchQueueEntries } from '#lib/batchQueue.js';

describe('batch queue templates', () => {
  test('parses and deduplicates App Store bundle IDs and version IDs', () => {
    expect(parseBatchQueueEntries('com.example.app\ncom.example.other@version_123\ncom.example.app', 'appstore')).toEqual({
      entries: [
        { bundleId: 'com.example.app' },
        { bundleId: 'com.example.other', selector: 'version_123' },
      ],
      duplicateBundleIds: ['com.example.app'],
      invalidSelectors: [],
    });
  });

  test('parses TestFlight selectors as version and build pairs', () => {
    expect(parseBatchQueueEntries('com.example.app@2.4.1_123\ncom.example.app@2.4.1_123', 'testflight')).toEqual({
      entries: [{ bundleId: 'com.example.app', selector: '2.4.1_123' }],
      duplicateBundleIds: ['com.example.app'],
      invalidSelectors: [],
    });
  });

  test('reports repeated bundle IDs with distinct versions and malformed selectors', () => {
    const result = parseBatchQueueEntries('com.example.app@one\ncom.example.app@two\ncom.example.bad@latest', 'testflight');
    expect(result.entries).toEqual([
      { bundleId: 'com.example.app', selector: 'one' },
      { bundleId: 'com.example.app', selector: 'two' },
      { bundleId: 'com.example.bad', selector: 'latest' },
    ]);
    expect(result.duplicateBundleIds).toEqual(['com.example.app']);
    expect(result.invalidSelectors).toEqual(['com.example.app@one', 'com.example.app@two', 'com.example.bad@latest']);
  });

  test('limits each queue template to fifty entries', () => {
    const lines = Array.from({ length: 60 }, (_, index) => `com.example.app${index}`).join('\n');
    expect(parseBatchQueueEntries(lines, 'appstore').entries).toHaveLength(50);
  });

  test('validates source-specific version selectors', () => {
    expect(parseBatchQueueEntries('com.example.app@version_123', 'appstore').invalidSelectors).toEqual([]);
    expect(parseBatchQueueEntries('com.example.app@version_123', 'testflight').invalidSelectors).toEqual(['com.example.app@version_123']);
    expect(parseBatchQueueEntries('com.example.app@2.4.1_123', 'testflight').invalidSelectors).toEqual([]);
  });

  test('offers only distinct devices from recently verified TestFlight access', () => {
    expect(getRecentlyVerifiedTestFlightDevices({
      lastVerifiedAt: 950,
      devices: [{ id: 'device-1', name: 'One' }, { id: 'device-1', name: 'One' }, { id: 'device-2', name: 'Two' }],
    }, 1000)).toEqual([
      { id: 'device-1', name: 'One' },
      { id: 'device-2', name: 'Two' },
    ]);
    expect(getRecentlyVerifiedTestFlightDevices({ lastVerifiedAt: 1000 - 31 * 60_000, devices: [{ id: 'old', name: 'Old' }] }, 1000)).toEqual([]);
    expect(getRecentlyVerifiedTestFlightDevices({ lastVerifiedAt: 1001, devices: [{ id: 'future', name: 'Future' }] }, 1000)).toEqual([
      { id: 'future', name: 'Future' },
    ]);
    expect(getRecentlyVerifiedTestFlightDevices({ lastVerifiedAt: 1000 + 5 * 60_000 + 1, devices: [{ id: 'far-future', name: 'Far future' }] }, 1000)).toEqual([]);
    expect(getRecentlyVerifiedTestFlightDevices({ lastVerifiedAt: 1000, devices: [] }, 1000)).toEqual([]);
  });
});
