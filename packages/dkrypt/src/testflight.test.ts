import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const installedInfoPlist = '/var/containers/Bundle/Application/B7CC6241-7F24-4683-A9BC-3E0F3DE60ED5/Discord.app/Info.plist';
const originalSetTimeout = globalThis.setTimeout;
let installRequests = 0;
let installedBuild = '107127';
const lifecycleActions: string[] = [];
const listAppRefreshes: boolean[] = [];

const idevice = await import('#idevice.js');
const state = await import('#store/state.js');

mock.module('#idevice.js', () => ({
  ...idevice,
  execCommand: async () => ({ stdout: `${installedInfoPlist}\n`, stderr: '', code: 0 }),
  isTestFlightRunning: async () => true,
  readInstalledBundleVersions: async (_conn: object, appPath: string) => ({ buildVersion: appPath.endsWith('.app') ? installedBuild : undefined }),
  sendSpringBoardBridgeRequest: async () => ({ launchResult: 0 }),
  sendTestFlightBridgeRequest: async (_conn: object, request: Record<string, unknown>) => {
    if (request.action === 'status') {
      return {
        bridgeVersion: '2.0.0',
        capabilities: ['list_trains', 'list_builds', 'list_apps', 'device_catalog', 'install', 'diagnostics', 'subscribe_invite', 'status_invite', 'unsubscribe_invite', 'invite_lifecycle', 'idempotent_install', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
        hasInstaller: true,
        hasCatalogManager: true,
      };
    }
    if (request.action === 'install') {
      installRequests += 1;
      if (installRequests >= 2) installedBuild = '107128';
    }
    if (request.action === 'subscribe_invite' || request.action === 'status_invite' || request.action === 'unsubscribe_invite') {
      lifecycleActions.push(String(request.action));
      if (request.action === 'status_invite') return { ok: true, verified: true };
    }
    if (request.action === 'list_apps') {
      listAppRefreshes.push(request.refresh === true);
      return { ok: true, apps: [{ appId: 985746746, bundleId: 'com.hammerandchisel.discord', name: 'Discord' }] };
    }
    return { ok: true };
  },
  withSSH: async (_rootDir: string, fn: (conn: object) => Promise<void>) => fn({}),
}));

mock.module('#store/state.js', () => ({
  ...state,
  getPrimaryDevice: () => ({ rootDir: '/device' }),
}));

const { installBuild, listTestFlightApps, statusTestFlightInvite, subscribeToTestFlightInvite, unsubscribeFromTestFlightInvite } = await import('./testflight.js');

describe('installBuild', () => {
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    mock.restore();
  });

  beforeEach(() => {
    installRequests = 0;
    installedBuild = '107127';
    lifecycleActions.length = 0;
    listAppRefreshes.length = 0;
    globalThis.setTimeout = ((handler: () => void) => originalSetTimeout(handler, 1)) as unknown as typeof setTimeout;
  });

  test('reads the installed build from the app bundle discovered through its Info.plist', async () => {
    await expect(installBuild(985746746, {
      id: 225052693,
      bundleId: 'com.hammerandchisel.discord',
      cfBundleShortVersion: '341.0',
      cfBundleVersion: '107127',
    }, undefined, 20, 'testflight-path-regression')).resolves.toMatchObject({
      bundleId: 'com.hammerandchisel.discord',
      fairPlayProtected: true,
      buildVersion: '107127',
    });
  });

  test('reissues a stalled install request before timing out', async () => {
    await expect(installBuild(985746746, {
      id: 225052693,
      bundleId: 'com.hammerandchisel.discord',
      cfBundleShortVersion: '341.0',
      cfBundleVersion: '107128',
    }, undefined, 30, 'testflight-retry', 0)).resolves.toMatchObject({
      bundleId: 'com.hammerandchisel.discord',
      buildVersion: '107128',
    });
    expect(installRequests).toBe(2);
  });

  test('supports authenticated invite lifecycle actions and status verification', async () => {
    await expect(subscribeToTestFlightInvite('https://testflight.apple.com/join/AbC123', 'invite-subscribe')).resolves.toMatchObject({ ok: true });
    await expect(statusTestFlightInvite('https://testflight.apple.com/join/AbC123', 985746746, 'invite-status')).resolves.toMatchObject({ ok: true, verified: true });
    await expect(unsubscribeFromTestFlightInvite('com.hammerandchisel.discord', undefined, 'invite-unsubscribe')).resolves.toMatchObject({ ok: true });
    expect(lifecycleActions).toEqual(['subscribe_invite', 'status_invite', 'unsubscribe_invite']);
  });

  test('reads the device TestFlight catalog through the bridge', async () => {
    await expect(listTestFlightApps()).resolves.toEqual([{ appId: 985746746, bundleId: 'com.hammerandchisel.discord', name: 'Discord' }]);
    await expect(listTestFlightApps(undefined, true)).resolves.toEqual([{ appId: 985746746, bundleId: 'com.hammerandchisel.discord', name: 'Discord' }]);
    expect(listAppRefreshes).toEqual([false, true]);
  });
});
