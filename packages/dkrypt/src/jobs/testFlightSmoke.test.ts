import { describe, expect, test } from 'bun:test';
import { isTestFlightSmokeDeviceVerified, listTestFlightSmokeCandidates, waitForTestFlightSmokeDeviceVerification, type TestFlightSmokeServices } from '#jobs/testFlightSmoke.js';
import type { TestFlightCatalogApp } from '#testflightSubscriptions.js';
import { TESTFLIGHT_VERIFICATION_TTL_MS } from '#testflightPolicy.js';
import type { DeviceRecord } from '#store/state.js';
import type { TFBuild, TFDeviceApp } from '#testflight.js';

const device = { id: 'ipad-usb', enabled: true } as DeviceRecord;
const app: TFDeviceApp = { appId: 123, bundleId: 'com.example.app' };

function build(overrides: Partial<TFBuild> = {}): TFBuild {
  return {
    id: 1,
    cfBundleShortVersion: '2.0',
    cfBundleVersion: '10',
    bundleId: app.bundleId,
    ...overrides,
  };
}

function services(overrides: Partial<TestFlightSmokeServices> = {}): TestFlightSmokeServices {
  return {
    listApps: async () => [app],
    listTrains: async () => [{ trainVersion: '2.0', buildCount: 2 }],
    listBuilds: async () => [build()],
    hasCachedArtifact: () => false,
    ...overrides,
  };
}

describe('TestFlight recovery smoke candidate selection', () => {
  test('accepts only recently verified access for the selected device', () => {
    const apps = [{
      bundleId: app.bundleId,
      devices: [
        { id: 'other-ipad', verifiedAt: 90_000 },
        { id: device.id, verifiedAt: 110_000 },
      ],
    }] as TestFlightCatalogApp[];

    expect(isTestFlightSmokeDeviceVerified(apps, app.bundleId, device.id, 110_000)).toBe(true);
    expect(isTestFlightSmokeDeviceVerified(apps, app.bundleId, 'other-ipad', 110_000)).toBe(true);
    expect(isTestFlightSmokeDeviceVerified(apps, app.bundleId, 'missing-ipad', 110_000)).toBe(false);
    expect(isTestFlightSmokeDeviceVerified(apps, app.bundleId, device.id, 2_000_000)).toBe(false);
  });

  test('retries completed coalesced refreshes until selected-device access is fresh', async () => {
    let now = 100_000_000;
    let refreshCalls = 0;
    let readsInCurrentRefresh = 0;

    await waitForTestFlightSmokeDeviceVerification(app.bundleId, device.id, {
      readCatalog: async () => {
        if (refreshCalls === 0) return { apps: [], fetchedAt: 1, refreshing: false };
        if (refreshCalls >= 3) return { apps: [{ bundleId: app.bundleId, devices: [{ id: device.id, name: 'iPad', verifiedAt: now }] }], fetchedAt: 4, refreshing: false };
        readsInCurrentRefresh += 1;
        if (readsInCurrentRefresh === 1) return { apps: [], fetchedAt: refreshCalls, refreshing: true };
        return {
          apps: [{ bundleId: app.bundleId, devices: [{ id: device.id, name: 'iPad', verifiedAt: now - TESTFLIGHT_VERIFICATION_TTL_MS - 1 }] }],
          fetchedAt: refreshCalls + 1,
          refreshing: false,
        };
      },
      refreshCatalog: async () => {
        refreshCalls += 1;
        readsInCurrentRefresh = 0;
      },
      now: () => now,
      wait: async (milliseconds) => { now += milliseconds; },
    });

    expect(refreshCalls).toBe(3);
  });

  test('refreshes the device catalog and orders uncached, unexpired builds newest first', async () => {
    const calls: unknown[][] = [];
    const candidates = await listTestFlightSmokeCandidates(app.bundleId, device, Date.parse('2026-10-02T00:00:00Z'), services({
      listApps: async (_device, refreshCatalog) => {
        calls.push(['apps', refreshCatalog]);
        return [app];
      },
      listTrains: async () => [
        { trainVersion: '1.9', buildCount: 1 },
        { trainVersion: '2.0', buildCount: 3 },
      ],
      listBuilds: async (_appId, trainVersion) => trainVersion === '2.0'
        ? [
            build({ id: 1, cfBundleVersion: '9' }),
            build({ id: 2, cfBundleVersion: '10', expiration: '2026-10-03T00:00:00Z' }),
            build({ id: 3, cfBundleVersion: '11', expiration: '2026-10-01T00:00:00Z' }),
            build({ id: 4, cfBundleVersion: '12', bundleId: 'com.example.other' }),
            build({ id: 5, cfBundleVersion: '13', expiration: 'invalid' }),
          ]
        : [build({ id: 6, cfBundleShortVersion: '1.9', cfBundleVersion: '30' })],
      hasCachedArtifact: (_bundleId, buildId) => buildId === 1,
    }));

    expect(calls).toEqual([['apps', true]]);
    expect(candidates.map(({ trainVersion, build: selected }) => [trainVersion, selected.id])).toEqual([
      ['2.0', 2],
      ['1.9', 6],
    ]);
  });

  test('rejects malformed bundle identifiers before querying the device', async () => {
    const listApps = async () => {
      throw new Error('device must not be queried');
    };

    await expect(listTestFlightSmokeCandidates('bad bundle id', device, Date.now(), services({ listApps })))
      .rejects.toThrow('invalid TestFlight smoke bundle identifier');
  });

  test('fails when the selected TestFlight app is absent from the device catalog', async () => {
    await expect(listTestFlightSmokeCandidates('com.missing.app', device, Date.now(), services()))
      .rejects.toThrow('TestFlight app com.missing.app is not visible in the device catalog');
  });

  test('returns no candidates when every build is expired or already cached', async () => {
    const candidates = await listTestFlightSmokeCandidates(app.bundleId, device, Date.parse('2026-10-02T00:00:00Z'), services({
      listBuilds: async () => [
        build({ id: 1, expiration: '2026-10-01T00:00:00Z' }),
        build({ id: 2, cfBundleVersion: '11' }),
      ],
      hasCachedArtifact: (_bundleId, buildId) => buildId === 2,
    }));

    expect(candidates).toEqual([]);
  });

  test('skips builds the device cannot run when the minimum iOS version is unknown or too high', async () => {
    const candidates = await listTestFlightSmokeCandidates(app.bundleId, { ...device, iosVersion: '16.7.10' } as DeviceRecord, Date.parse('2026-10-02T00:00:00Z'), services({
      listBuilds: async () => [
        build({ id: 1, minimumOsVersion: '17.0' }),
        build({ id: 2, minimumOSVersion: '16.7' }),
        build({ id: 3, minOsVersion: '15.0' }),
      ],
    }));

    expect(candidates.map(({ build: selected }) => selected.id).sort((left, right) => left - right)).toEqual([2, 3]);

    const unknownOsCandidates = await listTestFlightSmokeCandidates(app.bundleId, device, Date.parse('2026-10-02T00:00:00Z'), services({
      listBuilds: async () => [build({ id: 4, minimumOsVersion: '15.0' })],
    }));

    expect(unknownOsCandidates).toEqual([]);
  });
});
