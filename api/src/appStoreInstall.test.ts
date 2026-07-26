import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const progress: string[] = [];
let installedShortVersion = '338.0';
let installRequest: Record<string, unknown> | undefined;
let guardedUninstallFails = false;
const originalSetTimeout = globalThis.setTimeout;

const idevice = await import('#idevice.js');
const itunes = await import('#scheduler/itunes.js');
const state = await import('#store/state.js');

mock.module('#idevice.js', () => ({
  ...idevice,
  armAppStoreAutoConfirm: async () => calls.push('arm'),
  clearAppStoreAutoConfirm: async () => calls.push('clear'),
  findInstalledAppStoreBundle: async () => '/apps/Discord.app',
  isAppStoreRunning: async () => true,
  readInstalledBundleVersions: async () => ({ shortVersion: installedShortVersion, buildVersion: '106000' }),
  sendAppStoreBridgeRequest: async (_conn: object, request: Record<string, unknown>) => {
    installRequest = request;
    calls.push('request');
  },
  sendSpringBoardBridgeRequest: async () => ({ launchResult: 0 }),
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

const { installFromAppStore } = await import('./appStoreInstall.js');

describe('installFromAppStore', () => {
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    mock.restore();
  });

  beforeEach(() => {
    globalThis.setTimeout = ((handler: () => void) => {
      handler();
      return 0;
    }) as unknown as typeof setTimeout;
    calls.length = 0;
    progress.length = 0;
    installedShortVersion = '338.0';
    installRequest = undefined;
    guardedUninstallFails = false;
  });

  test('replaces an installed beta before decrypting a pinned App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord', {
      externalVersionId: '123456789',
      expectedVersion: '338.0',
      onProgress: (message) => progress.push(message),
    });

    expect(calls).toEqual(['uninstall', 'arm', 'request', 'clear']);
    expect(installRequest).toEqual({ action: 'install', adamId: 123, contextMode: 'fallback', versionId: 123456789 });
    expect(progress).toContain('removing the installed app before the App Store install');
    expect(progress.at(-1)).toBe('install complete in 0s');
  });

  test('replaces an installed app before decrypting the current App Store version', async () => {
    await installFromAppStore('com.hammerandchisel.discord');

    expect(calls).toEqual(['uninstall', 'arm', 'request', 'clear']);
    expect(installRequest).toEqual({ action: 'install', adamId: 123, contextMode: 'fallback' });
  });

  test('removes the discovered app bundle when the guarded uninstaller rejects it', async () => {
    guardedUninstallFails = true;

    await installFromAppStore('com.hammerandchisel.discord', { externalVersionId: '123456789', expectedVersion: '338.0' });

    expect(calls).toEqual(['uninstall', 'force-uninstall', 'arm', 'request', 'clear']);
  });

  test('refuses to decrypt a bundle whose installed version differs from the request', async () => {
    installedShortVersion = '341.0';

    await expect(
      installFromAppStore('com.hammerandchisel.discord', {
        externalVersionId: '123456789',
        expectedVersion: '338.0',
      }),
    ).rejects.toThrow('installed com.hammerandchisel.discord version 341.0, expected App Store version 338.0');

    expect(calls).toEqual(['uninstall', 'arm', 'request', 'clear']);
  });
});
