import { describe, expect, test } from 'bun:test';
import { listTestFlightSmokeCandidates, type TestFlightSmokeServices } from '#jobs/testFlightSmoke.js';
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
});
