import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const progress: string[] = [];
type InstalledBundle = { path: string; shortVersion: string };

let installedBundles: Array<InstalledBundle | undefined> = [];
let lastInstalledBundle: InstalledBundle | undefined;
let installRequest: Record<string, unknown> | undefined;
let guardedUninstallFails = false;
let foregroundStatuses: boolean[] = [];
let bridgeStatusErrors = 0;
let foregroundRequests = 0;
const originalSetTimeout = globalThis.setTimeout;
const originalDateNow = Date.now;

const idevice = await import('#idevice.js');
const itunes = await import('#scheduler/itunes.js');
const state = await import('#store/state.js');

mock.module('#idevice.js', () => ({
  ...idevice,
  armAppStoreAutoConfirm: async () => calls.push('arm'),
  clearAppStoreAutoConfirm: async () => calls.push('clear'),
  execCommand: async () => {
    calls.push('restart');
    return { stdout: '', stderr: '', code: 0 };
  },
  findInstalledAppStoreBundle: async () => {
    lastInstalledBundle = installedBundles.shift();
    return lastInstalledBundle?.path;
  },
  isAppStoreRunning: async () => true,
  readInstalledBundleVersions: async () => ({ shortVersion: lastInstalledBundle?.shortVersion, buildVersion: '106000' }),
  sendAppStoreBridgeRequest: async (_conn: object, request: Record<string, unknown>) => {
    if (request.action === 'status') {
      calls.push('status');
      if (bridgeStatusErrors > 0) {
        bridgeStatusErrors -= 1;
        throw new Error('status request timed out');
      }
      return { capabilities: ['install', 'status', 'diagnostics', 'foreground_status', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'], foreground: foregroundStatuses.shift() ?? true };
    }
    installRequest = request;
    calls.push('request');
    return { ok: true };
  },
  sendSpringBoardBridgeRequest: async () => {
    foregroundRequests += 1;
    return { launchResult: 0 };
  },
  uninstallInstalledApp: async () => {
    calls.push('uninstall');
    return !guardedUninstallFails;
  },
  uninstallInstalledBundle: async () => {
    calls.push('force-uninstall');
    return true;
  },
  withSSH: async (_rootDir: string, fn: (conn: object) => Promise<void>) => fn({}),
}));

mock.module('#scheduler/itunes.js', () => ({
  ...itunes,
  lookupCurrentVersion: async () => ({ trackId: 123, version: '338.0' }),
}));

mock.module('#store/state.js', () => ({
  ...state,
  getPrimaryDevice: () => ({ rootDir: '/device' }),
}));

const { buildAppStoreOperationId, installFromAppStore } = await import('./appStoreInstall.js');

describe('installFromAppStore', () => {
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    Date.now = originalDateNow;
    mock.restore();
  });

  beforeEach(() => {
    globalThis.setTimeout = ((handler: () => void) => {
      handler();
      return 0;
    }) as unknown as typeof setTimeout;
    calls.length = 0;
    progress.length = 0;
    installedBundles = [
      { path: '/apps/Discord.app', shortVersion: '338.0' },
      { path: '/apps/Discord.app', shortVersion: '338.0' },
    ];
    lastInstalledBundle = undefined;
    installRequest = undefined;
    guardedUninstallFails = false;
    foregroundStatuses = [true];
    bridgeStatusErrors = 0;
    foregroundRequests = 0;
  });

  test('uses a distinct bridge operation id for each job retry', () => {
    const firstAttempt = buildAppStoreOperationId('job-id', 0);
    const retryAttempt = buildAppStoreOperationId('job-id', 1);

    expect(firstAttempt).toBe('job-id');
    expect(retryAttempt).toBe('job-id-retry-1');
    expect(retryAttempt).not.toBe(firstAttempt);
  });

  test('retries after a temporarily unavailable bridge before purchasing', async () => {
    bridgeStatusErrors = 1;
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls.filter((call) => call === 'status')).toHaveLength(2);
    expect(foregroundRequests).toBe(2);
    expect(calls).toEqual(['restart', 'status', 'status', 'arm', 'request', 'clear']);
  });

  test('continues when the App Store bridge is responsive but inactive', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 20_000;
      handler();
      return 0;
    }) as unknown as typeof setTimeout;
    foregroundStatuses = [false];
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    try {
      await expect(installFromAppStore('com.hammerandchisel.discord')).resolves.toMatchObject({ bundleId: 'com.hammerandchisel.discord', shortVersion: '338.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'clear']);
  });

  test('replaces an installed beta before decrypting a pinned App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['uninstall', 'restart', 'status', 'arm', 'request', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, contextMode: 'fallback', versionId: 123456789 });
    expect(installRequest).not.toHaveProperty('requestId');
    expect(progress).toContain('removing the installed app before the App Store install');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('replaces an installed app before decrypting the current App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls).toEqual(['uninstall', 'restart', 'status', 'arm', 'request', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, contextMode: 'fallback' });
  });

  test('removes the discovered app bundle when the guarded uninstaller rejects it', async () => {
    guardedUninstallFails = true;

    await installFromAppStore('com.hammerandchisel.discord', { externalVersionId: '123456789', expectedVersion: '338.0' });

    expect(calls).toEqual(['uninstall', 'force-uninstall', 'restart', 'status', 'arm', 'request', 'clear']);
  });

  test('waits for the requested version when a stale App Store install lands first', async () => {
    installedBundles = [
      undefined,
      { path: '/apps/Discord.app', shortVersion: '337.0' },
      { path: '/apps/Discord.app', shortVersion: '338.0' },
    ];

    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'clear']);
    expect(progress).toContain('waiting for App Store version 338.0; version 337.0 is currently installed');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('stops before contacting the App Store when cancelled', async () => {
    await expect(installFromAppStore('com.hammerandchisel.discord', { isCancelled: () => true })).rejects.toThrow('App Store install cancelled');

    expect(calls).toEqual([]);
  });
});
