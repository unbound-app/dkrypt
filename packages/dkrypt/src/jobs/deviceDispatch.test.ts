import { describe, expect, test } from 'bun:test';
import { getJobDeviceBlocker } from './deviceDispatch.js';
import type { DeviceHealth } from '#deviceHealth.js';
import type { Job } from '#jobs/types.js';
import type { TestFlightCatalogCache } from '#store/state.js';

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'job-1',
    bundleId: 'com.example.app',
    source: 'manual',
    priority: 0,
    status: 'queued',
    progress: 'queued',
    createdAt: 1,
    waiters: [],
    ...overrides,
  };
}

function makeHealth(overrides: Partial<DeviceHealth> = {}): DeviceHealth {
  return { reachable: true, jailbreakAvailable: true, checkedAt: 1, ...overrides };
}

function makeCatalog(overrides: Partial<TestFlightCatalogCache> = {}): TestFlightCatalogCache {
  return {
    fetchedAt: 1_000,
    deviceIds: ['ipad-a'],
    apps: [{
      appId: 42,
      bundleId: 'com.example.app',
      displayName: 'Example',
      devices: [{ id: 'ipad-a', name: 'iPad A', verifiedAt: 1_000 }],
      lastVerifiedAt: 1_000,
      deviceSource: true,
    }],
    complete: true,
    ...overrides,
  };
}

describe('job device eligibility', () => {
  test('allows dispatch when health is unknown', () => {
    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, {}, 1_000)).toBeUndefined();
  });

  test('waits instead of assigning a job to a device with a known install blocker', () => {
    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health: makeHealth({ reachable: false, error: 'device is unreachable' }) }, 1_000))
      .toBe('device is unreachable');
  });

  test('waits for a device whose rootless jailbreak is unavailable', () => {
    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health: makeHealth({ jailbreakAvailable: false }) }, 1_000))
      .toBe('rootless jailbreak is unavailable');
  });

  test('waits for a device whose rootless jailbreak could not be verified', () => {
    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health: makeHealth({ jailbreakAvailable: undefined }) }, 1_000))
      .toBe('rootless jailbreak status could not be verified');
  });

  test('blocks both install sources when the shared SpringBoard bridge is unavailable', () => {
    const health = makeHealth({ testFlightBridgeReachable: false });
    const testFlightJob = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7' } } });
    const state = { health, testFlightCatalog: makeCatalog() };

    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, state, 1_001)).toBe('autoinstall SpringBoard bridge is unresponsive');
    expect(getJobDeviceBlocker(testFlightJob, { id: 'ipad-a' }, state, 1_001)).toBe('autoinstall SpringBoard bridge is unresponsive');
  });

  test('applies App Store and TestFlight subsystem failures only to matching jobs', () => {
    const testFlightJob = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7' } } });
    const appStoreOffline = makeHealth({ subsystems: {
      usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'offline', testFlight: 'ready', sshTunnel: 'ready', storage: 'ready', battery: 'ready', thermal: 'ready',
    } });
    const testFlightOffline = makeHealth({ subsystems: {
      usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'ready', testFlight: 'offline', sshTunnel: 'ready', storage: 'ready', battery: 'ready', thermal: 'ready',
    } });

    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health: appStoreOffline }, 1_001)).toBe('App Store subsystem is offline');
    expect(getJobDeviceBlocker(testFlightJob, { id: 'ipad-a' }, { health: appStoreOffline, testFlightCatalog: makeCatalog() }, 1_001)).toBeUndefined();
    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health: testFlightOffline }, 1_001)).toBeUndefined();
    expect(getJobDeviceBlocker(testFlightJob, { id: 'ipad-a' }, { health: testFlightOffline, testFlightCatalog: makeCatalog() }, 1_001)).toBe('TestFlight subsystem is offline');
  });

  test('does not queue App Store work because its process heartbeat is stale', () => {
    const health = makeHealth({
      subsystems: {
        usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'unknown', testFlight: 'unknown', sshTunnel: 'ready', storage: 'ready', battery: 'ready', thermal: 'ready',
      },
      bridgeHeartbeats: { appstore: { at: 0 } },
    });

    expect(getJobDeviceBlocker(makeJob(), { id: 'ipad-a' }, { health }, Date.now())).toBeUndefined();
  });

  test('stale TestFlight process heartbeats do not block scheduler dispatch when device access is verified', () => {
    const now = 31 * 60_000;
    const job = makeJob({
      source: 'scheduler',
      testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7' } },
    });
    const health = makeHealth({
      subsystems: {
        usb: 'ready', mux: 'ready', agent: 'ready', appStore: 'unknown', testFlight: 'unknown', sshTunnel: 'ready', storage: 'ready', battery: 'ready', thermal: 'ready',
      },
      bridgeHeartbeats: { testflight: { at: 0 } },
    });
    const catalog = makeCatalog({
      fetchedAt: now,
      apps: [{
        appId: 42,
        bundleId: 'com.example.app',
        displayName: 'Example',
        devices: [{ id: 'ipad-a', name: 'iPad A', verifiedAt: now }],
        lastVerifiedAt: now,
        deviceSource: true,
      }],
    });

    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { health, testFlightCatalog: catalog }, now)).toBeUndefined();
  });

  test('checks storage requirements before assigning a known TestFlight build', () => {
    const job = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7', fileSize: 100 } } });
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { health: makeHealth({ storageFreeBytes: 150 }), testFlightCatalog: makeCatalog() }, 1_000))
      .toContain('storage');
  });

  test('requires fresh TestFlight verification for the exact app and device', () => {
    const job = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7' } } });
    expect(getJobDeviceBlocker(job, { id: 'ipad-b' }, { testFlightCatalog: makeCatalog() }, 1_000)).toContain('not verified');
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { testFlightCatalog: makeCatalog() }, 1_000 + 30 * 60_000 + 1)).toContain('verification is stale');
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { testFlightCatalog: makeCatalog() }, 1_001)).toBeUndefined();
  });

  test('does not infer per-device verification from a legacy app-wide timestamp', () => {
    const job = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7' } } });
    const catalog = makeCatalog({ apps: [{
      appId: 42,
      bundleId: 'com.example.app',
      displayName: 'Example',
      devices: [{ id: 'ipad-a', name: 'iPad A' }],
      lastVerifiedAt: 1_000,
      deviceSource: true,
    }] });
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { testFlightCatalog: catalog }, 1_001)).toContain('individually verified');
  });

  test('requires a reported iOS version before dispatching a minimum-OS build', () => {
    const job = makeJob({ testflight: { appId: 42, build: { id: 7, bundleId: 'com.example.app', cfBundleShortVersion: '2.0', cfBundleVersion: '7', minimumOsVersion: '17.0' } } });
    expect(getJobDeviceBlocker(job, { id: 'ipad-a', iosVersion: '16.7.10' }, { testFlightCatalog: makeCatalog() }, 1_001))
      .toContain('requires iOS 17.0');
    expect(getJobDeviceBlocker(job, { id: 'ipad-a', iosVersion: '17.0' }, { testFlightCatalog: makeCatalog() }, 1_001)).toBeUndefined();
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, { testFlightCatalog: makeCatalog() }, 1_001))
      .toBe('device iOS version is unknown; cannot verify minimum iOS 17.0');
  });

  test('requires a reported iOS version before dispatching a minimum-OS App Store build', () => {
    const job = makeJob({ minimumOsVersion: '17.0' });
    expect(getJobDeviceBlocker(job, { id: 'ipad-a', iosVersion: '16.7.10' }, {}, 1_001)).toContain('requires iOS 17.0');
    expect(getJobDeviceBlocker(job, { id: 'ipad-a', iosVersion: '17.0' }, {}, 1_001)).toBeUndefined();
    expect(getJobDeviceBlocker(job, { id: 'ipad-a' }, {}, 1_001))
      .toBe('device iOS version is unknown; cannot verify minimum iOS 17.0');
  });
});
