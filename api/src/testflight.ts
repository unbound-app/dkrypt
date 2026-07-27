import { Client } from 'ssh2';
import { scopedLogger } from '#logger.js';
import {
  execCommand,
  BridgeError,
  isTestFlightRunning,
  readInstalledBundleVersions,
  sendSpringBoardBridgeRequest,
  sendTestFlightBridgeRequest,
  withSSH,
} from '#idevice.js';
import { getPrimaryDevice } from '#store/state.js';

function primaryRootDir(): string {
  return getPrimaryDevice().rootDir;
}

const log = scopedLogger('testflight');

export interface TFTrain {
  trainVersion: string;
  buildCount: number;
}

export interface TFBuild {
  id: number;
  cfBundleShortVersion: string;
  cfBundleVersion: string;
  bundleId: string;
  whatsNew?: string;
  releaseDate?: string;
  expiration?: string;
  fileSize?: number;
  [key: string]: unknown;
}

export interface TestFlightBridgeDiagnostics {
  bridge: {
    bridgeVersion?: string;
    capabilities?: string[];
    hasInstaller?: boolean;
    hasCatalogManager?: boolean;
    backgroundTaskActive?: boolean;
    backgroundTimeRemaining?: number;
  };
  install?: Record<string, unknown>;
  recentLog?: string[];
}

const REQUIRED_BRIDGE_CAPABILITIES = ['list_trains', 'list_builds', 'install', 'diagnostics', 'idempotent_install'];

function isCompatibleBridge(response: Record<string, unknown>): boolean {
  const version = typeof response.bridgeVersion === 'string' ? response.bridgeVersion : '';
  const [major, minor] = version.split('.').map(Number);
  const capabilities = Array.isArray(response.capabilities) ? response.capabilities.filter((value): value is string => typeof value === 'string') : [];
  return major === 1 && minor >= 1 && REQUIRED_BRIDGE_CAPABILITIES.every((capability) => capabilities.includes(capability));
}

async function launchTestFlight(conn: Client, wasRunning: boolean): Promise<void> {
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.TestFlight' });
  if (!wasRunning && response?.launchResult !== 0) {
    throw new Error(`autoinstall SpringBoard launch_app failed: ${JSON.stringify(response)}`);
  }
}

async function enableDarkAwakeMode(conn: Client): Promise<void> {
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'dark_on' });
  if (response?.ok === false) log.warn('autoinstall dark-awake mode was not confirmed', { response });
}

async function waitForBridgeReady(conn: Client, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendTestFlightBridgeRequest(conn, { action: 'status' }, 3_000);
      if (response?.hasInstaller && response?.hasCatalogManager && isCompatibleBridge(response)) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('autoinstall bridge did not become ready within timeout');
}

export async function ensureTestFlightRunning(): Promise<void> {
  await withSSH(primaryRootDir(), async (conn) => {
    await enableDarkAwakeMode(conn);
    const wasRunning = await isTestFlightRunning(conn);
    log.info(
      wasRunning
        ? 'TestFlight already running, bringing to foreground to confirm the bridge is responsive'
        : 'launching TestFlight autonomously via autoinstall SpringBoard bridge',
    );
    await launchTestFlight(conn, wasRunning);
    await new Promise((r) => setTimeout(r, wasRunning ? 2_000 : 3_000));
    await waitForBridgeReady(conn);
  });
}

export async function listTrains(appId: number): Promise<TFTrain[]> {
  return withReadyBridgeRequest(() => withSSH(primaryRootDir(), async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_trains', appId });
    return response.data as TFTrain[];
  }));
}

export async function listBuilds(appId: number, trainVersion: string): Promise<TFBuild[]> {
  return withReadyBridgeRequest(() => withSSH(primaryRootDir(), async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_builds', appId, trainVersion });
    return response.data as TFBuild[];
  }));
}

async function withReadyBridgeRequest<T>(request: () => Promise<T>): Promise<T> {
  await ensureTestFlightRunning();
  return withBridgeRecovery(request);
}

async function withBridgeRecovery<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof BridgeError) || !err.details.retryable) throw err;
    log.warn('recovering a retryable TestFlight bridge request', { code: err.details.code, stage: err.details.stage });
    await ensureTestFlightRunning();
    return request();
  }
}

export async function getTestFlightBridgeDiagnostics(): Promise<TestFlightBridgeDiagnostics> {
  return withReadyBridgeRequest(() => withSSH(primaryRootDir(), async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'diagnostics' });
    return response.data as TestFlightBridgeDiagnostics;
  }));
}

async function findInstalledBundlePath(conn: Client, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `find /var/containers/Bundle/Application -maxdepth 1 -exec sh -c "grep -la ${bundleId} {}/*.app/Info.plist 2>/dev/null" \\; 2>/dev/null`,
  );
  const line = stdout.trim().split('\n')[0];
  return line || undefined;
}

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;

export async function installBuild(
  appId: number,
  build: TFBuild,
  onProgress?: (message: string) => void,
  waitTimeoutMs = 4 * 60_000,
  operationId?: string,
): Promise<void> {
  if (!SAFE_BUNDLE_ID_RE.test(build.bundleId)) {
    throw new Error(`refusing to install build with unsafe bundleId: ${JSON.stringify(build.bundleId)}`);
  }

  const report = (message: string) => {
    log.info(message, { bundleId: build.bundleId, targetVersion: build.cfBundleVersion });
    onProgress?.(message);
  };

  report('ensuring TestFlight is running');
  await ensureTestFlightRunning();

  await withSSH(primaryRootDir(), async (conn) => {
    report('sending install request to TestFlight');
    await sendTestFlightBridgeRequest(conn, { action: 'install', appId, build, operationId });
    report('TestFlight accepted the install request, waiting for it to land');

    const start = Date.now();
    const deadline = start + waitTimeoutMs;
    let lastReportedAt = 0;
    while (Date.now() < deadline) {
      const bundlePath = await findInstalledBundlePath(conn, build.bundleId);
      if (bundlePath) {
        const { buildVersion } = await readInstalledBundleVersions(conn, bundlePath);
        if (buildVersion === build.cfBundleVersion) {
          report(`install complete in ${Math.round((Date.now() - start) / 1000)}s`);
          return;
        }
      }
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      if (elapsedSec - lastReportedAt >= 10) {
        lastReportedAt = elapsedSec;
        report(`still waiting for TestFlight to finish installing (${elapsedSec}s elapsed)`);
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(`timed out waiting for ${build.bundleId} to reach build ${build.cfBundleVersion} after ${Math.round(waitTimeoutMs / 1000)}s`);
  });
}
