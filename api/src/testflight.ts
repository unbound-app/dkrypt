import { Client } from 'ssh2';
import { scopedLogger } from './logger.js';
import {
  execCommand,
  isTestFlightRunning,
  sendSpringBoardBridgeRequest,
  sendTestFlightBridgeRequest,
  withSSH,
} from './idevice.js';

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

async function launchTestFlight(conn: Client): Promise<void> {
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.TestFlight' });
  if (response?.launchResult !== 0) {
    throw new Error(`tfauto SpringBoard launch_app failed: ${JSON.stringify(response)}`);
  }
}

async function waitForBridgeReady(conn: Client, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendTestFlightBridgeRequest(conn, { action: 'status' }, 3_000);
      if (response?.hasInstaller && response?.hasCatalogManager) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('tfauto bridge did not become ready within timeout');
}

export async function ensureTestFlightRunning(): Promise<void> {
  await withSSH(async (conn) => {
    if (await isTestFlightRunning(conn)) {
      log.info('TestFlight already running');
      return;
    }
    log.info('launching TestFlight autonomously via tfauto SpringBoard bridge');
    await launchTestFlight(conn);
    await new Promise((r) => setTimeout(r, 3_000));
    await waitForBridgeReady(conn);
  });
}

export async function listTrains(appId: number): Promise<TFTrain[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_trains', appId });
    return response.data as TFTrain[];
  });
}

export async function listBuilds(appId: number, trainVersion: string): Promise<TFBuild[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendTestFlightBridgeRequest(conn, { action: 'list_builds', appId, trainVersion });
    return response.data as TFBuild[];
  });
}

async function findInstalledBundlePath(conn: Client, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `find /var/containers/Bundle/Application -maxdepth 1 -exec sh -c "grep -la ${bundleId} {}/*.app/Info.plist 2>/dev/null" \\; 2>/dev/null`,
  );
  const line = stdout.trim().split('\n')[0];
  return line || undefined;
}

async function readInstalledBundleVersion(conn: Client, infoPlistPath: string): Promise<string | undefined> {
  const tmp = `/tmp/dkrypt-check-${Date.now()}.plist`;
  await execCommand(conn, `cp "${infoPlistPath}" ${tmp} && chmod 644 ${tmp} && /cores/binpack/usr/bin/plutil -convert xml1 ${tmp}`);
  const { stdout } = await execCommand(conn, `cat ${tmp}`);
  await execCommand(conn, `rm -f ${tmp}`);
  const match = stdout.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1];
}

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;

export async function installBuild(
  appId: number,
  build: TFBuild,
  onProgress?: (message: string) => void,
  waitTimeoutMs = 4 * 60_000,
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

  await withSSH(async (conn) => {
    report('sending install request to TestFlight');
    await sendTestFlightBridgeRequest(conn, { action: 'install', appId, build });
    report('TestFlight accepted the install request, waiting for it to land');

    const start = Date.now();
    const deadline = start + waitTimeoutMs;
    let lastReportedAt = 0;
    while (Date.now() < deadline) {
      const bundlePath = await findInstalledBundlePath(conn, build.bundleId);
      if (bundlePath) {
        const version = await readInstalledBundleVersion(conn, bundlePath);
        if (version === build.cfBundleVersion) {
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
