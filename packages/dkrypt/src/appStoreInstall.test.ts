import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const progress: string[] = [];
type InstalledBundle = { path: string; shortVersion: string };

let installedBundles: Array<InstalledBundle | undefined> = [];
let lastInstalledBundle: InstalledBundle | undefined;
let installRequest: Record<string, unknown> | undefined;
let installStatus: Record<string, unknown> = {};
let installStatusAfterRequest: Record<string, unknown> | undefined;
let installStatusSequence: Record<string, unknown>[] = [];
let guardedUninstallFails = false;
let foregroundStatuses: boolean[] = [];
let bridgeStatusErrors = 0;
let foregroundRequests = 0;
let listingPrice = 0;
let listingBundleId = '';
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
      if (installRequest && installStatusSequence.length > 0) installStatus = installStatusSequence.shift()!;
      return { capabilities: ['install', 'status', 'diagnostics', 'foreground_status', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'], foreground: foregroundStatuses.shift() ?? true, install: installStatus };
    }
    installRequest = request;
    calls.push('request');
    if (installStatusAfterRequest) installStatus = installStatusAfterRequest;
    return { ok: true, requested: true, operationId: request.operationId };
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
  withSSH: async (_device: object, fn: (conn: object) => Promise<void>) => fn({}),
}));

mock.module('#scheduler/itunes.js', () => ({
  ...itunes,
  lookupCurrentVersion: async (bundleId: string) => {
    listingBundleId = bundleId;
    return { trackId: 123, version: '338.0' };
  },
  lookupAppMetadataByTrackId: async () => ({ trackId: 123, bundleId: listingBundleId, trackName: 'Example App', price: listingPrice }),
}));

mock.module('#store/state.js', () => ({
  ...state,
  getPrimaryDevice: () => ({ id: 'test-device', transport: 'usb', udid: 'test-device' }),
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
    installStatus = {};
    installStatusAfterRequest = undefined;
    installStatusSequence = [];
    guardedUninstallFails = false;
    foregroundStatuses = [true];
    bridgeStatusErrors = 0;
    foregroundRequests = 0;
    listingPrice = 0;
    listingBundleId = '';
  });

  test('uses a distinct bridge operation id for each job retry', () => {
    const firstAttempt = buildAppStoreOperationId('job-id', 0);
    const retryAttempt = buildAppStoreOperationId('job-id', 1);

    expect(firstAttempt).toBe('job-id');
    expect(retryAttempt).toBe('job-id-retry-1');
    expect(retryAttempt).not.toBe(firstAttempt);
  });

  test('rejects an already cancelled job before contacting the device', async () => {
    const controller = new AbortController();
    controller.abort(new Error('job deadline exceeded'));

    await expect(installFromAppStore('com.hammerandchisel.discord', { signal: controller.signal })).rejects.toThrow('job deadline exceeded');
    expect(calls).toEqual([]);
  });

  test('refuses a paid listing before changing the device', async () => {
    listingPrice = 1.99;
    await expect(installFromAppStore('com.example.app')).rejects.toThrow('requires a verified free listing');
    expect(calls).toEqual([]);
  });

  test('does not demand human action while App Store authorization remains pending', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      handler();
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [undefined, undefined, undefined, undefined, undefined];
    installStatusAfterRequest = {
      operationId: 'job-payment-authorization',
      state: 'requires_user_action',
      reason: 'payment_authorization_ui',
    };

    try {
      await expect(installFromAppStore('com.example.app', {
        operationId: 'job-payment-authorization',
        waitTimeoutMs: 20_000,
        onProgress: (message) => progress.push(message),
      })).rejects.toThrow('Autoinstall could not complete the free App Store confirmation');
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(progress.some((message) => message.includes('device action'))).toBe(false);
    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'status', 'status', 'status', 'status', 'clear']);
  });

  test('waits through a payment sheet until the requested version installs', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 5_000;
      handler();
      return 0;
    }) as unknown as typeof setTimeout;
    installedBundles = [undefined, undefined, undefined, undefined, undefined, { path: '/apps/Discord.app', shortVersion: '348.0' }];
    installStatusSequence = [
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'requires_user_action', reason: 'payment_authorization_ui' },
      { operationId: 'job-transient-payment-authorization', state: 'completed' },
    ];

    try {
      await expect(installFromAppStore('com.example.app', {
        expectedVersion: '348.0',
        operationId: 'job-transient-payment-authorization',
      })).resolves.toMatchObject({ shortVersion: '348.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'status', 'status', 'status', 'status', 'status', 'clear']);
  });

  test('retries after a temporarily unavailable bridge before purchasing', async () => {
    bridgeStatusErrors = 1;
    installedBundles = [undefined, { path: '/apps/Discord.app', shortVersion: '338.0' }];

    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls.filter((call) => call === 'status')).toHaveLength(3);
    expect(foregroundRequests).toBe(2);
    expect(calls).toEqual(['restart', 'status', 'status', 'arm', 'request', 'status', 'clear']);
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

    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'status', 'clear']);
  });

  test('replaces an installed beta before decrypting a pinned App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, appName: 'Example App', verifiedPrice: 0, contextMode: 'fallback', versionId: 123456789 });
    expect(installRequest).not.toHaveProperty('requestId');
    expect(progress).toContain('removing the installed app before the App Store install');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('normalizes a v-prefixed App Store version before verification', async () => {
    let now = 0;
    Date.now = () => now;
    globalThis.setTimeout = ((handler: () => void) => {
      now += 20_000;
      handler();
      return 0;
    }) as unknown as typeof setTimeout;

    try {
      await expect(installFromAppStore('com.hammerandchisel.discord', {
        externalVersionId: '123456789',
        expectedVersion: 'v338.0',
        onProgress: (message) => progress.push(message),
      })).resolves.toMatchObject({ bundleId: 'com.hammerandchisel.discord', shortVersion: '338.0' });
    } finally {
      Date.now = originalDateNow;
      globalThis.setTimeout = originalSetTimeout;
    }

    expect(progress).not.toContain('waiting for App Store version v338.0; version 338.0 is currently installed');
  });

  test('replaces an installed app before decrypting the current App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls).toEqual(['uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(installRequest).toMatchObject({ action: 'install', adamId: 123, contextMode: 'fallback' });
  });

  test('removes the discovered app bundle when the guarded uninstaller rejects it', async () => {
    guardedUninstallFails = true;

    await installFromAppStore('com.hammerandchisel.discord', { externalVersionId: '123456789', expectedVersion: '338.0' });

    expect(calls).toEqual(['uninstall', 'force-uninstall', 'restart', 'status', 'arm', 'request', 'status', 'clear']);
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

    expect(calls).toEqual(['restart', 'status', 'arm', 'request', 'status', 'clear']);
    expect(progress).toContain('waiting for App Store version 338.0; version 337.0 is currently installed');
    expect(progress.at(-1)).toBe('install verified: 338.0 build 106000 in 0s');
  });

  test('stops before contacting the App Store when cancelled', async () => {
    await expect(installFromAppStore('com.hammerandchisel.discord', { isCancelled: () => true })).rejects.toThrow('App Store install cancelled');

    expect(calls).toEqual([]);
  });
});
