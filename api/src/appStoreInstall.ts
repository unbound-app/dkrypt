import type { Client } from 'ssh2';
import {
  armAppStoreAutoConfirm,
  clearAppStoreAutoConfirm,
  execCommand,
  findInstalledAppStoreBundle,
  isAppStoreRunning,
  readInstalledBundleVersions,
  sendAppStoreBridgeRequest,
  sendSpringBoardBridgeRequest,
  uninstallInstalledBundle,
  uninstallInstalledApp,
  withSSH,
} from '#idevice.js';
import { scopedLogger } from '#logger.js';
import { lookupCurrentVersion } from '#scheduler/itunes.js';
import { getPrimaryDevice } from '#store/state.js';

const log = scopedLogger('appstore');

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;
const APP_EXT_VERSION_ID_RE = /^\d{1,20}$/;

function primaryRootDir(): string {
  return getPrimaryDevice().rootDir;
}

async function ensureAppStoreForeground(conn: Client): Promise<void> {
  const wasRunning = await isAppStoreRunning(conn);
  const response = await sendSpringBoardBridgeRequest(conn, { action: 'launch_app', bundleId: 'com.apple.AppStore' });
  if (!wasRunning && response?.launchResult !== 0) {
    throw new Error(`autoinstall SpringBoard launch_app (AppStore) failed: ${JSON.stringify(response)}`);
  }

  await new Promise((r) => setTimeout(r, wasRunning ? 4_000 : 8_000));
}

async function restartAppStore(conn: Client): Promise<void> {
  await execCommand(conn, 'killall AppStore 2>/dev/null || true');
  await new Promise((r) => setTimeout(r, 1_000));
}

export async function uninstallFromPrimaryDevice(bundleId: string): Promise<boolean> {
  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) return false;
  try {
    return await withSSH(primaryRootDir(), (conn) => uninstallInstalledApp(conn, bundleId));
  } catch (err) {
    log.warn('device uninstall failed', { bundleId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

export interface AppStoreInstallOptions {
  externalVersionId?: string;
  expectedVersion?: string;
  onProgress?: (message: string) => void;
  waitTimeoutMs?: number;
  isCancelled?: () => boolean;
}

export async function installFromAppStore(bundleId: string, options: AppStoreInstallOptions = {}): Promise<void> {
  const { externalVersionId, expectedVersion, onProgress, waitTimeoutMs = 5 * 60_000 } = options;

  if (!SAFE_BUNDLE_ID_RE.test(bundleId)) {
    throw new Error(`refusing to install App Store app with unsafe bundleId: ${JSON.stringify(bundleId)}`);
  }
  const versionId = externalVersionId && APP_EXT_VERSION_ID_RE.test(externalVersionId) ? Number(externalVersionId) : undefined;
  if (externalVersionId && versionId === undefined) {
    throw new Error(`refusing to install with non-numeric externalVersionId: ${JSON.stringify(externalVersionId)}`);
  }

  const report = (message: string) => {
    log.info(message, { bundleId, externalVersionId });
    onProgress?.(message);
  };
  const ensureNotCancelled = () => {
    if (options.isCancelled?.()) throw new Error('App Store install cancelled');
  };

  ensureNotCancelled();
  report('resolving App Store id for bundle');
  const { trackId, version: latestVersion } = await lookupCurrentVersion(bundleId);
  const targetVersion = expectedVersion ?? (versionId === undefined ? latestVersion : undefined);

  await withSSH(primaryRootDir(), async (conn) => {
    ensureNotCancelled();
    const existing = await findInstalledAppStoreBundle(conn, bundleId);
    if (existing) {
      report('removing the installed app before the App Store install');
      const removed = (await uninstallInstalledApp(conn, bundleId)) || (await uninstallInstalledBundle(conn, bundleId, existing));
      if (!removed) {
        throw new Error(`failed to remove the existing ${bundleId} before installing from the App Store`);
      }
    }

    report('restarting the App Store to clear pending purchases');
    await restartAppStore(conn);

    report('bringing the App Store to the foreground');
    await ensureAppStoreForeground(conn);

    try {
      ensureNotCancelled();
      report('arming headless auto-confirm and sending install request');
      await armAppStoreAutoConfirm(conn, 'Install');

      const request: Record<string, unknown> = { action: 'install', adamId: trackId, contextMode: 'fallback' };
      if (versionId !== undefined) request.versionId = versionId;
      await sendAppStoreBridgeRequest(conn, request);
      report(
        versionId !== undefined
          ? `App Store accepted the install request (version ${versionId}), waiting for it to land`
          : 'App Store accepted the install request, waiting for it to land',
      );

      const start = Date.now();
      const deadline = start + waitTimeoutMs;
      let lastReportedAt = 0;
      let lastUnexpectedVersion: string | undefined;
      while (Date.now() < deadline) {
        ensureNotCancelled();
        const bundlePath = await findInstalledAppStoreBundle(conn, bundleId);
        if (bundlePath) {
          const { shortVersion } = await readInstalledBundleVersions(conn, bundlePath);
          if (targetVersion && shortVersion !== targetVersion) {
            const unexpectedVersion = shortVersion ?? 'unknown';
            if (lastUnexpectedVersion !== unexpectedVersion) {
              report(`waiting for App Store version ${targetVersion}; version ${unexpectedVersion} is currently installed`);
              lastUnexpectedVersion = unexpectedVersion;
            }
          } else {
            report(`install complete in ${Math.round((Date.now() - start) / 1000)}s`);
            return;
          }
        }
        const elapsedSec = Math.round((Date.now() - start) / 1000);
        if (elapsedSec - lastReportedAt >= 10) {
          lastReportedAt = elapsedSec;
          report(`still waiting for the App Store to finish installing (${elapsedSec}s elapsed)`);
        }
        await new Promise((r) => setTimeout(r, 5_000));
      }
      if (lastUnexpectedVersion && targetVersion) {
        throw new Error(`timed out waiting for ${bundleId} version ${targetVersion}; version ${lastUnexpectedVersion} remained installed after ${Math.round(waitTimeoutMs / 1000)}s`);
      }
      throw new Error(`timed out waiting for ${bundleId} to install from the App Store after ${Math.round(waitTimeoutMs / 1000)}s`);
    } finally {
      await clearAppStoreAutoConfirm(conn).catch(() => {});
    }
  });
}
