import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const installedInfoPlist = '/var/containers/Bundle/Application/B7CC6241-7F24-4683-A9BC-3E0F3DE60ED5/Discord.app/Info.plist';
const originalSetTimeout = globalThis.setTimeout;

const idevice = await import('#idevice.js');
const state = await import('#store/state.js');

mock.module('#idevice.js', () => ({
  ...idevice,
  execCommand: async () => ({ stdout: `${installedInfoPlist}\n`, stderr: '', code: 0 }),
  isTestFlightRunning: async () => true,
  readInstalledBundleVersions: async (_conn: object, appPath: string) => ({ buildVersion: appPath.endsWith('.app') ? '107127' : undefined }),
  sendSpringBoardBridgeRequest: async () => ({ launchResult: 0 }),
  sendTestFlightBridgeRequest: async (_conn: object, request: Record<string, unknown>) => {
    if (request.action === 'status') {
      return {
        bridgeVersion: '2.0.0',
        capabilities: ['list_trains', 'list_builds', 'install', 'diagnostics', 'idempotent_install', 'protocol_v1', 'authenticated_requests', 'operation_responses', 'heartbeats', 'stale_artifact_cleanup'],
        hasInstaller: true,
        hasCatalogManager: true,
      };
    }
    return { ok: true };
  },
  withSSH: async (_rootDir: string, fn: (conn: object) => Promise<void>) => fn({}),
}));

mock.module('#store/state.js', () => ({
  ...state,
  getPrimaryDevice: () => ({ rootDir: '/device' }),
}));

const { installBuild } = await import('./testflight.js');

describe('installBuild', () => {
  afterAll(() => {
    globalThis.setTimeout = originalSetTimeout;
    mock.restore();
  });

  beforeEach(() => {
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
});
