import { describe, expect, test } from 'bun:test';
import { IMMUTABLE_TESTFLIGHT_BUNDLE_ID, isImmutableTestFlightBundle, mergeDeviceTestFlightApps, normalizeTestFlightInvite, parseTestFlightInviteHtml, readTestFlightCatalogCache } from '#testflightSubscriptions.js';

describe('TestFlight public links', () => {
  test('normalizes canonical links and removes query state', () => {
    expect(normalizeTestFlightInvite(' https://testflight.apple.com/join/AbC123/?source=share#invite ')).toEqual({
      url: 'https://testflight.apple.com/join/AbC123',
      inviteCode: 'AbC123',
    });
  });

  test('rejects non-public or non-Apple links', () => {
    for (const value of [
      'http://testflight.apple.com/join/AbC123',
      'https://example.com/join/AbC123',
      'itms-beta://testflight.apple.com/join/AbC123',
      'https://testflight.apple.com/join/ab',
      'https://testflight.apple.com/apps/123',
    ]) {
      expect(() => normalizeTestFlightInvite(value)).toThrow();
    }
  });

  test('extracts app metadata from TestFlight invite HTML', () => {
    const parsed = parseTestFlightInviteHtml('<title>Join the Discord beta - TestFlight - Apple</title><meta property="og:image" content="https://example.com/icon.png">');
    expect(parsed).toEqual({ displayName: 'Discord', iconUrl: 'https://example.com/icon.png' });
  });
});

describe('device TestFlight catalog', () => {
  test('keeps cached access available while detecting device changes', () => {
    const cache = {
      fetchedAt: 100,
      deviceIds: ['ipad-a'],
      apps: [{
        appId: 42,
        bundleId: 'com.example.app',
        displayName: 'Example',
        devices: [{ id: 'ipad-a', name: 'iPad A' }],
        lastVerifiedAt: 100,
        deviceSource: true as const,
      }],
    };
    expect(readTestFlightCatalogCache(cache, [{ id: 'ipad-a', name: 'iPad A', enabled: true } as never], 1_000)).toMatchObject({
      apps: [{ bundleId: 'com.example.app', devices: [{ id: 'ipad-a' }] }],
      stale: false,
    });
    expect(readTestFlightCatalogCache(cache, [{ id: 'ipad-b', name: 'iPad B', enabled: true } as never], 1_000)).toEqual({
      apps: [],
      fetchedAt: 100,
      stale: true,
    });
    expect(readTestFlightCatalogCache({ ...cache, complete: false }, [{ id: 'ipad-a', name: 'iPad A', enabled: true } as never], 1_000)?.stale).toBe(true);
  });

  test('merges app access by device and keeps the device as the source of truth', () => {
    const apps = mergeDeviceTestFlightApps([
      { device: { id: 'ipad-a', name: 'iPad A', enabled: true } as never, fetchedAt: 100, apps: [{ appId: 42, bundleId: 'com.example.app', name: 'Example' }] },
      { device: { id: 'ipad-b', name: 'iPad B', enabled: true } as never, fetchedAt: 200, apps: [{ appId: 42, bundleId: 'com.example.app', name: 'Example' }] },
    ]);
    expect(apps).toEqual([{ appId: 42, bundleId: 'com.example.app', displayName: 'Example', devices: [{ id: 'ipad-a', name: 'iPad A' }, { id: 'ipad-b', name: 'iPad B' }], lastVerifiedAt: 200, deviceSource: true }]);
  });

  test('protects the immutable Discord subscription', () => {
    expect(isImmutableTestFlightBundle(IMMUTABLE_TESTFLIGHT_BUNDLE_ID)).toBe(true);
    expect(isImmutableTestFlightBundle('com.example.app')).toBe(false);
  });
});
