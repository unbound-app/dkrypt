import { Client } from 'ssh2';
import { scopedLogger } from '#logger.js';
import {
  execCommand,
  BridgeError,
  isTestFlightRunning,
  readInstalledBundleVersions,
  sendSpringBoardBridgeRequest,
  sendTestFlightBridgeRequest,
  type InstallVerification,
  withSSH,
} from '#idevice.js';
import { getPrimaryDevice, type DeviceRecord } from '#store/state.js';
import { hasBridgeCapabilities, hasBridgeCapabilitySet, TESTFLIGHT_DEVICE_CATALOG_CAPABILITIES, TESTFLIGHT_LIFECYCLE_CAPABILITIES } from '#bridgeProtocol.js';

function primaryDevice() {
  const device = getPrimaryDevice();
  if (!device) throw new Error('No enabled device is configured');
  return device;
}

const log = scopedLogger('testflight');
const TESTFLIGHT_INSTALL_RETRY_AFTER_MS = 2 * 60_000;

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

export interface TFDeviceApp {
  appId: number;
  bundleId: string;
  name?: string;
  providerName?: string;
  publicLinkURL?: string;
  publicLinkStatus?: string;
  inviteStatus?: string;
  isPublicLinkUser?: boolean;
}

function hasRequiredBridgeCapabilities(response: Record<string, unknown>): boolean {
  return hasBridgeCapabilities('testflight', response.capabilities);
}

async function launchTestFlight(conn: Client, wasRunning: boolean): Promise<void> {
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.TestFlight' });
  if (!wasRunning && response?.launchResult !== 0) {
    throw new Error(`autoinstall SpringBoard launch_app failed: ${JSON.stringify(response)}`);
  }
}

async function waitForBridgeReady(conn: Client, requiredCapabilities: readonly string[] = [], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendTestFlightBridgeRequest(conn, { action: 'status' }, 3_000);
      const hasBaseCapabilities = hasRequiredBridgeCapabilities(response);
      const hasRequestedCapabilities = hasBridgeCapabilitySet(response?.capabilities, requiredCapabilities);
      if (response?.hasInstaller && response?.hasCatalogManager && hasBaseCapabilities && hasRequestedCapabilities) return;
      if (requiredCapabilities.length > 0 && response?.hasInstaller && response?.hasCatalogManager && hasBaseCapabilities && !hasRequestedCapabilities) {
        throw new BridgeError({ code: 'unsupported', stage: 'capability_negotiation', message: 'installed autoinstall package does not support the required TestFlight lifecycle capabilities', retryable: false });
      }
    } catch (error) {
      if (error instanceof BridgeError && !error.details.retryable) throw error;
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('autoinstall bridge did not become ready within timeout');
}

export async function ensureTestFlightRunning(device = primaryDevice(), requiredCapabilities: readonly string[] = []): Promise<void> {
  return withSSH(device, async (conn) => {
    const wasRunning = await isTestFlightRunning(conn);
    log.info(
      wasRunning
        ? 'TestFlight already running, bringing to foreground to confirm the bridge is responsive'
        : 'launching TestFlight autonomously via autoinstall SpringBoard bridge',
    );
    await launchTestFlight(conn, wasRunning);
    await new Promise((r) => setTimeout(r, wasRunning ? 2_000 : 3_000));
    await waitForBridgeReady(conn, requiredCapabilities);
  });
}

export async function listTrains(appId: number, device = primaryDevice()): Promise<TFTrain[]> {
  return withReadyBridgeRequest(() => withSSH(device, async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_trains', appId });
    return response.data as TFTrain[];
  }), device);
}

export async function listBuilds(appId: number, trainVersion: string, device = primaryDevice()): Promise<TFBuild[]> {
  return withReadyBridgeRequest(() => withSSH(device, async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_builds', appId, trainVersion });
    return response.data as TFBuild[];
  }), device);
}

const TESTFLIGHT_INVITE_URL_RE = /^https:\/\/testflight\.apple\.com\/join\/([A-Za-z0-9]{4,32})$/;

export async function subscribeToTestFlightInvite(url: string, operationId: string, device = primaryDevice(), appId?: number): Promise<Record<string, unknown>> {
  if (!TESTFLIGHT_INVITE_URL_RE.test(url)) throw new Error('invalid TestFlight public link');
  return withReadyBridgeRequest(() => withSSH(device, (conn) => sendTestFlightBridgeRequest(conn, {
    action: 'subscribe_invite',
    url,
    operationId,
    ...(appId && Number.isInteger(appId) && appId > 0 ? { appId } : {}),
  })), device, TESTFLIGHT_LIFECYCLE_CAPABILITIES);
}

export async function statusTestFlightInvite(url: string, appId: number, operationId: string, device = primaryDevice()): Promise<Record<string, unknown>> {
  if (!TESTFLIGHT_INVITE_URL_RE.test(url) || !Number.isInteger(appId) || appId <= 0) throw new Error('invalid TestFlight invite status request');
  return withReadyBridgeRequest(() => withSSH(device, (conn) => sendTestFlightBridgeRequest(conn, {
    action: 'status_invite',
    url,
    appId,
    operationId,
  })), device, TESTFLIGHT_LIFECYCLE_CAPABILITIES);
}

export async function unsubscribeFromTestFlightInvite(bundleId: string, device = primaryDevice(), operationId?: string): Promise<Record<string, unknown>> {
  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) throw new Error('invalid bundle identifier');
  return withReadyBridgeRequest(() => withSSH(device, (conn) => sendTestFlightBridgeRequest(conn, {
    action: 'unsubscribe_invite',
    bundleId,
    operationId,
  })), device, TESTFLIGHT_LIFECYCLE_CAPABILITIES);
}

export async function listTestFlightApps(device = primaryDevice()): Promise<TFDeviceApp[]> {
  return withReadyBridgeRequest(() => withSSH(device, async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_apps' });
    if (!Array.isArray(response.apps)) return [];
    return response.apps.filter((entry: unknown): entry is TFDeviceApp => {
      if (typeof entry !== 'object' || entry === null) return false;
      const value = entry as Record<string, unknown>;
      return Number.isInteger(value.appId) && Number(value.appId) > 0 && typeof value.bundleId === 'string' && value.bundleId.length > 0;
    });
  }), device, TESTFLIGHT_DEVICE_CATALOG_CAPABILITIES);
}

async function withReadyBridgeRequest<T>(request: () => Promise<T>, device: DeviceRecord, requiredCapabilities: readonly string[] = []): Promise<T> {
  await ensureTestFlightRunning(device, requiredCapabilities);
  return withBridgeRecovery(request, device, requiredCapabilities);
}

async function withBridgeRecovery<T>(request: () => Promise<T>, device: DeviceRecord, requiredCapabilities: readonly string[] = []): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof BridgeError) || !err.details.retryable) throw err;
    log.warn('recovering a retryable TestFlight bridge request', { code: err.details.code, stage: err.details.stage });
    await ensureTestFlightRunning(device, requiredCapabilities);
    return request();
  }
}

export async function getTestFlightBridgeDiagnostics(device = primaryDevice()): Promise<TestFlightBridgeDiagnostics> {
  return withReadyBridgeRequest(() => withSSH(device, async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'diagnostics' });
    return response.data as TestFlightBridgeDiagnostics;
  }), device);
}

async function findInstalledBundlePath(conn: Client, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `find /var/containers/Bundle/Application -maxdepth 1 -exec sh -c "grep -la ${bundleId} {}/*.app/Info.plist 2>/dev/null" \\; 2>/dev/null`,
  );
  const line = stdout.trim().split('\n')[0];
  return line.endsWith('/Info.plist') ? line.slice(0, -'/Info.plist'.length) : undefined;
}

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;

export async function installBuild(
  appId: number,
  build: TFBuild,
  onProgress?: (message: string) => void,
  waitTimeoutMs = 4 * 60_000,
  operationId?: string,
  retryAfterMs = TESTFLIGHT_INSTALL_RETRY_AFTER_MS,
  device = primaryDevice(),
): Promise<InstallVerification> {
  if (!SAFE_BUNDLE_ID_RE.test(build.bundleId)) {
    throw new Error(`refusing to install build with unsafe bundleId: ${JSON.stringify(build.bundleId)}`);
  }

  const report = (message: string) => {
    log.info(message, { bundleId: build.bundleId, targetVersion: build.cfBundleVersion });
    onProgress?.(message);
  };

  report('ensuring TestFlight is running');
  await ensureTestFlightRunning(device);

  return withSSH(device, async (conn) => {
    report('sending install request to TestFlight');
    await sendTestFlightBridgeRequest(conn, { action: 'install', appId, build, operationId, requestId: operationId });
    report('TestFlight accepted the install request, waiting for it to land');

    const start = Date.now();
    const deadline = start + waitTimeoutMs;
    let lastReportedAt = 0;
    let lastUnexpectedBuild: string | undefined;
    let installRetried = false;
    while (Date.now() < deadline) {
      const bundlePath = await findInstalledBundlePath(conn, build.bundleId);
      if (bundlePath) {
        const installedVersion = await readInstalledBundleVersions(conn, bundlePath);
        const { buildVersion } = installedVersion;
        if (buildVersion === build.cfBundleVersion) {
          report(`install verified: ${installedVersion.shortVersion ?? build.cfBundleShortVersion} build ${buildVersion} in ${Math.round((Date.now() - start) / 1000)}s`);
          return { ...installedVersion, bundleId: build.bundleId, appPath: bundlePath, fairPlayProtected: true, elapsedMs: Date.now() - start };
        }
        if (buildVersion && buildVersion !== lastUnexpectedBuild) {
          lastUnexpectedBuild = buildVersion;
          report(`waiting for TestFlight build ${build.cfBundleVersion}; build ${buildVersion} is currently installed`);
        }
      }
      if (!installRetried && Date.now() - start >= retryAfterMs) {
        installRetried = true;
        report('reissuing the TestFlight install request after no version change');
        await sendTestFlightBridgeRequest(conn, { action: 'install', appId, build, operationId, requestId: operationId });
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
