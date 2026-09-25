import { describe, expect, test } from 'bun:test';
import { applyDeviceSshTunnelHealth, coalesceDeviceHealthRequest, collectDeviceTelemetry, formatTestFlightBridgeDownDescription, getDeviceAgentSubsystemState, getDeviceInstallBlocker, getDeviceReadiness, getDeviceSshTunnelSubsystemState, isBridgeHeartbeatFresh, parseDeviceStorageDf, stabilizeDeviceHealth, testFlightBridgeReachability, type DeviceHealth } from '#deviceHealth.js';

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

  test('blocks decrypt when USB SSH or SFTP is unavailable without marking the device offline', () => {
    const deviceHealth = applyDeviceSshTunnelHealth({
      reachable: true,
      checkedAt: 0,
      subsystems: {
        usb: 'ready',
        mux: 'ready',
        agent: 'ready',
        appStore: 'unknown',
        testFlight: 'unknown',
        sshTunnel: 'unknown',
        storage: 'unknown',
        battery: 'unknown',
        thermal: 'unknown',
      },
    }, { udid: 'usb-device' }, false);

    expect(deviceHealth.reachable).toBe(true);
    expect(deviceHealth.subsystems?.sshTunnel).toBe('degraded');
    expect(getDeviceReadiness(deviceHealth).state).toBe('ready');
    expect(getDeviceInstallBlocker(deviceHealth)).toBe('device SSH/SFTP tunnel is unavailable for decrypt');
  });
});

describe('device agent subsystem health', () => {
  test('separates a connected Rust agent from SpringBoard bridge reachability', () => {
    expect(getDeviceAgentSubsystemState({ udid: 'usb-device' }, true)).toBe('ready');
    expect(getDeviceAgentSubsystemState({ udid: 'usb-device' }, false)).toBe('offline');
    expect(getDeviceAgentSubsystemState({ host: '192.0.2.10' }, true)).toBe('unsupported');
  });
});

describe('device SSH/SFTP subsystem health', () => {
  test('keeps tunnel failure decrypt-specific for a working Rust device connection', () => {
    expect(getDeviceSshTunnelSubsystemState({ udid: 'usb-device' }, true)).toBe('ready');
    expect(getDeviceSshTunnelSubsystemState({ udid: 'usb-device' }, false)).toBe('degraded');
    expect(getDeviceSshTunnelSubsystemState({ host: '192.0.2.10' }, false)).toBe('offline');
  });
});

describe('TestFlight bridge alerts', () => {
  test('keeps bridge reachability aligned with the health sample', () => {
    expect(testFlightBridgeReachability(health({ testFlightBridgeReachable: true }))).toBe(true);
    expect(testFlightBridgeReachability(health({ testFlightBridgeReachable: false }))).toBe(false);
    expect(testFlightBridgeReachability(health({ reachable: false, testFlightBridgeReachable: false }))).toBeUndefined();
  });

  test('describes the outage without speculative tweak recovery advice', () => {
    expect(formatTestFlightBridgeDownDescription('iPad Pro', 15)).toBe(
      "The autoinstall SpringBoard bridge on iPad Pro has stopped responding for at least 15 minutes - TestFlight installs and the scheduler's TestFlight watch can't run until it recovers.",
    );
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

describe('collectDeviceTelemetry', () => {
  test('keeps telemetry failures from making an established SSH session unreachable', async () => {
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const query = <T>(value: T, shouldFail = false) => async (): Promise<T> => {
      activeQueries += 1;
      maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
      await Promise.resolve();
      activeQueries -= 1;
      if (shouldFail) throw new Error('Unable to exec');
      return value;
    };

    const telemetry = await collectDeviceTelemetry({
      testFlightRunning: query(false, true),
      springBoardStatus: query({ ok: false, value: undefined }, true),
      battery: query(undefined),
      storage: query(undefined),
      network: query(undefined),
      bridgeHeartbeats: query({}),
    });

    expect(maxActiveQueries).toBe(1);
    expect(telemetry.testFlightRunning).toBeFalse();
    expect(telemetry.testFlightBridgeReachable).toBeFalse();
    expect(telemetry.bridgeHeartbeats).toEqual({});
  });

  test('stops collecting telemetry as soon as the job is aborted', async () => {
    const controller = new AbortController();
    const calls: string[] = [];

    await expect(collectDeviceTelemetry({
      testFlightRunning: async () => {
        calls.push('testFlightRunning');
        controller.abort(new Error('job deadline exceeded'));
        return true;
      },
      springBoardStatus: async () => {
        calls.push('springBoardStatus');
        return { ok: true };
      },
      battery: async () => undefined,
      storage: async () => undefined,
      network: async () => undefined,
      bridgeHeartbeats: async () => ({}),
    }, controller.signal)).rejects.toThrow('job deadline exceeded');

    expect(calls).toEqual(['testFlightRunning']);
  });
});

describe('device health coordination', () => {
  test('shares one refresh across concurrent callers', async () => {
    const pending = new Map<string, Promise<number>>();
    let calls = 0;
    let resolveRequest: ((value: number) => void) | undefined;
    const request = () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        resolveRequest = resolve;
      });
    };

    const first = coalesceDeviceHealthRequest(pending, 'device-a', request);
    const second = coalesceDeviceHealthRequest(pending, 'device-a', request);
    resolveRequest?.(42);

    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(calls).toBe(1);
    expect(pending).toHaveLength(0);
  });

  test('keeps a known-good status through one transient failure', () => {
    const previous = health({ checkedAt: 100 });
    const failed = health({ reachable: false, error: 'Timed out while waiting for handshake', checkedAt: 200 });

    expect(stabilizeDeviceHealth(previous, failed, 1)).toEqual({ ...previous, checkedAt: 200 });
    expect(stabilizeDeviceHealth(previous, failed, 2)).toEqual({ ...previous, checkedAt: 200 });
    expect(stabilizeDeviceHealth(previous, failed, 3)).toBe(failed);
    expect(stabilizeDeviceHealth(undefined, failed, 1)).toBe(failed);
  });

  test('keeps a ready status through transient bridge failures', () => {
    const previous = health({ checkedAt: 100, readiness: { score: 100, state: 'ready', reasons: [] } });
    const failed = health({
      checkedAt: 200,
      testFlightBridgeReachable: false,
      readiness: { score: 50, state: 'blocked', reasons: ['autoinstall bridge is unresponsive'] },
    });

    expect(stabilizeDeviceHealth(previous, failed, 1)).toEqual({ ...previous, checkedAt: 200 });
    expect(stabilizeDeviceHealth(previous, failed, 2)).toEqual({ ...previous, checkedAt: 200 });
    expect(stabilizeDeviceHealth(previous, failed, 3)).toBe(failed);
  });

  test('does not hide a confirmed readiness blocker', () => {
    const previous = health({
      checkedAt: 100,
      testFlightBridgeReachable: false,
      readiness: { score: 50, state: 'blocked', reasons: ['autoinstall bridge is unresponsive'] },
    });
    const failed = health({ reachable: false, error: 'Connection lost before handshake', checkedAt: 200 });

    expect(stabilizeDeviceHealth(previous, failed, 1)).toBe(failed);
  });
});
