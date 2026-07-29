import { describe, expect, test } from 'bun:test';
import { getDeviceInstallBlocker, getDeviceReadiness, isBridgeHeartbeatFresh, parseDeviceStorageDf, type DeviceHealth } from '#deviceHealth.js';

function health(overrides: Partial<DeviceHealth> = {}): DeviceHealth {
  return { reachable: true, checkedAt: 0, ...overrides };
}

describe('getDeviceReadiness', () => {
  test('keeps a healthy device ready', () => {
    expect(getDeviceReadiness(health())).toEqual({ score: 100, state: 'ready', reasons: [] });
  });

  test('blocks automation when the device loses internet or bridge access', () => {
    expect(getDeviceReadiness(health({ internetAccess: false })).state).toBe('blocked');
    expect(getDeviceReadiness(health({ testFlightBridgeReachable: false })).state).toBe('blocked');
  });

  test('defers installs for unsafe battery, thermal, and size-aware storage conditions', () => {
    expect(getDeviceInstallBlocker(health({ batteryPercent: 14, batteryCharging: false }))).toContain('battery');
    expect(getDeviceInstallBlocker(health({ batteryTemperatureC: 45 }))).toContain('temperature');
    expect(getDeviceInstallBlocker(health({ storageFreeBytes: 199_000_000 }), 100_000_000)).toMatch(/storage.*GB/);
    expect(getDeviceInstallBlocker(health({ storageFreeBytes: 201_000_000 }), 100_000_000)).toBeUndefined();
    expect(getDeviceInstallBlocker(health({ storageFreeBytes: 1024 }))).toBeUndefined();
  });

  test('defers installs when the authenticated heartbeat is stale', () => {
    const now = 1_000_000;
    expect(isBridgeHeartbeatFresh({ at: (now - 90_001) / 1000 }, now)).toBeFalse();
    expect(getDeviceInstallBlocker(health({ bridgeHeartbeats: { springboard: { at: 0 } } }))).toContain('heartbeat');
  });
});

describe('parseDeviceStorageDf', () => {
  test('uses the available space rather than the per-volume used figure on APFS', () => {
    const storage = parseDeviceStorageDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1s2 30720000 7168000 1740800 81% /private/var\n');

    expect(storage).toEqual({
      totalBytes: 30_720_000 * 1024,
      usedBytes: 28_979_200 * 1024,
      freeBytes: 1_740_800 * 1024,
      usedPercent: 28_979_200 / 30_720_000,
    });
  });
});
