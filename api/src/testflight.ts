import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import { config } from './config.js';
import { scopedLogger } from './logger.js';
import { EMBED_COLOR, notify } from './notify.js';
import { getEffectiveSettings, recordDeviceHealthCheck } from './store/state.js';
import { getDiskUsage } from './util/diskUsage.js';

const log = scopedLogger('testflight');
const deviceLog = scopedLogger('idevice');

const REQUEST_PATH = '/tmp/tfauto-request.json';
const RESPONSE_PATH = '/tmp/tfauto-response.json';
const SB_REQUEST_PATH = '/tmp/tfauto-sb-request.json';
const SB_RESPONSE_PATH = '/tmp/tfauto-sb-response.json';

interface DeviceAuth {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

interface RawIpadecryptConfig {
  device?: {
    host?: string;
    port?: number;
    user?: string;
    auth?: { keyPath?: string };
  };
}

let cachedAuth: DeviceAuth | undefined;

async function loadDeviceAuth(): Promise<DeviceAuth> {
  if (cachedAuth) return cachedAuth;
  const raw = JSON.parse(await readFile(config.ipadecryptConfigPath, 'utf8')) as RawIpadecryptConfig;
  const device = raw.device;
  if (!device?.host || !device.port || !device.user || !device.auth?.keyPath) {
    throw new Error('ipadecrypt config is missing device connection info (host/port/user/auth.keyPath)');
  }
  cachedAuth = { host: device.host, port: device.port, user: device.user, keyPath: device.auth.keyPath };
  return cachedAuth;
}

async function withSSH<T>(fn: (conn: Client) => Promise<T>): Promise<T> {
  const auth = await loadDeviceAuth();
  let privateKey: Buffer;
  try {
    privateKey = await readFile(auth.keyPath);
  } catch (err) {
    // The key path came from a cached config read - if it no longer resolves, the config
    // probably changed (key rotation) since we cached it. Drop the cache so the next call
    // re-reads it, instead of requiring a server restart to pick up the change.
    cachedAuth = undefined;
    throw err;
  }
  const conn = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => resolve());
      conn.on('error', reject);
      conn.connect({ host: auth.host, port: auth.port, username: auth.user, privateKey, readyTimeout: 15_000 });
    });
    return await fn(conn);
  } catch (err) {
    // Same reasoning for connection-level auth failures (e.g. the device no longer accepts
    // this key) - self-heal by re-reading config on the next attempt rather than staying wrong
    // until someone restarts the process.
    cachedAuth = undefined;
    throw err;
  } finally {
    conn.end();
  }
}

function execCommand(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => resolve({ stdout, stderr, code }));
      stream.on('error', reject);
    });
  });
}

function writeRemoteFile(conn: Client, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => resolve());
      stream.on('error', reject);
      stream.end(content);
    });
  });
}

async function readRemoteFileIfExists(conn: Client, remotePath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', (streamErr: NodeJS.ErrnoException) => {
        if (streamErr.code === 'ENOENT' || streamErr.message?.includes('No such file')) {
          resolve(undefined);
        } else {
          reject(streamErr);
        }
      });
    });
  });
}

async function isTestFlightRunning(conn: Client): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i '/TestFlight$' | grep -v grep");
  return stdout.trim().length > 0;
}

async function launchTestFlight(conn: Client): Promise<void> {
  const response = await sendBridgeRequestRawTo(conn, SB_REQUEST_PATH, SB_RESPONSE_PATH, { action: 'launch_app', bundleId: 'com.apple.TestFlight' });
  if (response?.launchResult !== 0) {
    throw new Error(`tfauto SpringBoard launch_app failed: ${JSON.stringify(response)}`);
  }
}

async function waitForBridgeReady(conn: Client, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendBridgeRequestRaw(conn, { action: 'status' }, 3_000);
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

// tfauto watches fixed, well-known paths (it's an external companion tool, not something we
// control the source of), so concurrent bridge requests can't be made independently addressable.
// Serialize them instead - otherwise two admins acting at once would race and corrupt each
// other's request/response files.
let bridgeQueue: Promise<unknown> = Promise.resolve();

function withBridgeLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = bridgeQueue.then(fn, fn);
  bridgeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function sendBridgeRequestRawTo(
  conn: Client,
  requestPath: string,
  responsePath: string,
  request: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<any> {
  return withBridgeLock(async () => {
    await execCommand(conn, `rm -f ${responsePath}`);
    await writeRemoteFile(conn, requestPath, JSON.stringify(request));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await readRemoteFileIfExists(conn, responsePath);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.ok === false) throw new Error(`tfauto bridge error: ${parsed.error}`);
        return parsed;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`tfauto bridge request timed out: ${JSON.stringify(request)}`);
  });
}

function sendBridgeRequestRaw(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, REQUEST_PATH, RESPONSE_PATH, request, timeoutMs);
}

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

export async function listTrains(appId: number): Promise<TFTrain[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendBridgeRequestRaw(conn, { action: 'list_trains', appId });
    return response.data as TFTrain[];
  });
}

export async function listBuilds(appId: number, trainVersion: string): Promise<TFBuild[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendBridgeRequestRaw(conn, { action: 'list_builds', appId, trainVersion });
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
    await sendBridgeRequestRaw(conn, { action: 'install', appId, build });
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

export interface DeviceHealth {
  reachable: boolean;
  error?: string;
  testFlightRunning?: boolean;
  testFlightBridgeReachable?: boolean;
  darkEnabled?: boolean;
  screenIsOn?: boolean;
  backlightState?: number;
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryCycleCount?: number;
  batteryHealthPercent?: number;
  batteryDesignCapacityMah?: number;
  batteryMaxCapacityMah?: number;
  storageTotalBytes?: number;
  storageUsedBytes?: number;
  storageFreeBytes?: number;
  storageUsedPercent?: number;
  checkedAt: number;
}

function parseIoregValue(output: string, key: string): string | undefined {
  return new RegExp(`"${key}" = ([^\\n]+)`).exec(output)?.[1]?.trim();
}

interface BatteryStatus {
  batteryPercent?: number;
  batteryCharging?: boolean;
  batteryTemperatureC?: number;
  batteryCycleCount?: number;
  batteryHealthPercent?: number;
  batteryDesignCapacityMah?: number;
  batteryMaxCapacityMah?: number;
}

// Plain `ioreg` isn't reliably on PATH over SSH on every jailbreak setup - readInstalledBundleVersion
// above hits the same problem with plutil and works around it with an explicit binpack path, so try
// the same fallback locations here rather than assuming the bare command resolves.
const IOREG_CANDIDATES = ['ioreg', '/usr/sbin/ioreg', '/cores/binpack/usr/sbin/ioreg', '/cores/binpack/usr/bin/ioreg'];

const IOREG_BATTERY_CLASS = 'AppleARMPMUCharger';

async function runIoreg(conn: Client): Promise<string | undefined> {
  for (const bin of IOREG_CANDIDATES) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${IOREG_BATTERY_CLASS} -w 0 2>&1`);
    if (code === 0 && stdout.includes(IOREG_BATTERY_CLASS)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}

async function queryBatteryStatus(conn: Client): Promise<BatteryStatus | undefined> {
  const stdout = await runIoreg(conn);
  if (!stdout) {
    deviceLog.warn('ioreg is not available on the device via any known path - battery telemetry disabled');
    return undefined;
  }

  const currentCapacity = Number(parseIoregValue(stdout, 'CurrentCapacity'));
  const maxCapacity = Number(parseIoregValue(stdout, 'MaxCapacity'));
  const isCharging = parseIoregValue(stdout, 'IsCharging');
  const temperature = Number(parseIoregValue(stdout, 'Temperature'));
  const cycleCount = Number(parseIoregValue(stdout, 'CycleCount'));
  const designCapacity = Number(parseIoregValue(stdout, 'DesignCapacity'));
  const rawMaxCapacity = Number(parseIoregValue(stdout, 'AppleRawMaxCapacity'));

  if (!Number.isFinite(currentCapacity) || !maxCapacity) {
    deviceLog.warn('ioreg output did not contain the expected AppleARMPMUCharger fields', { sample: stdout.slice(0, 500) });
  }

  return {
    batteryPercent: Number.isFinite(currentCapacity) && maxCapacity ? Math.round((currentCapacity / maxCapacity) * 100) : undefined,
    batteryCharging: isCharging === undefined ? undefined : isCharging === 'Yes',
    batteryTemperatureC: Number.isFinite(temperature) ? temperature / 100 : undefined,
    batteryCycleCount: Number.isFinite(cycleCount) ? cycleCount : undefined,
    batteryHealthPercent:
      Number.isFinite(designCapacity) && designCapacity > 0 && Number.isFinite(rawMaxCapacity)
        ? Math.round((rawMaxCapacity / designCapacity) * 100)
        : undefined,
    batteryDesignCapacityMah: Number.isFinite(designCapacity) ? designCapacity : undefined,
    batteryMaxCapacityMah: Number.isFinite(rawMaxCapacity) ? rawMaxCapacity : undefined,
  };
}

interface DeviceStorage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usedPercent: number;
}

// Parses from the right rather than assuming a fixed column count - a busybox `df` wraps a long
// filesystem name onto its own line, but the trailing numeric columns stay in the same relative
// order either way, so this holds up across jailbreak/df implementations.
async function queryDeviceStorage(conn: Client): Promise<DeviceStorage | undefined> {
  const { stdout, code } = await execCommand(conn, 'df -k /private/var 2>&1');
  if (code !== 0) {
    deviceLog.warn('device storage df query failed', { code, output: stdout.slice(0, 200) });
    return undefined;
  }

  const lines = stdout.trim().split('\n').filter(Boolean);
  let parsed: { totalKb: number; usedKb: number; freeKb: number } | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const match = line.match(/(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+\d+%\b/);
    if (!match) continue;
    parsed = {
      totalKb: Number(match[1]),
      usedKb: Number(match[2]),
      freeKb: Number(match[3]),
    };
    break;
  }

  if (!parsed) {
    deviceLog.warn('device storage df output did not contain expected numeric columns', {
      sample: lines[lines.length - 1]?.slice(0, 200),
    });
    return undefined;
  }

  const totalBytes = parsed.totalKb * 1024;
  const usedBytes = parsed.usedKb * 1024;
  const freeBytes = parsed.freeKb * 1024;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) {
    deviceLog.warn('device storage df output did not contain parseable numbers', {
      sample: lines[lines.length - 1]?.slice(0, 200),
    });
    return undefined;
  }

  return { totalBytes, usedBytes, freeBytes, usedPercent: usedBytes / totalBytes };
}

const HEALTH_CACHE_TTL_MS = 20_000;
let healthCache: { at: number; value: DeviceHealth } | undefined;

async function computeDeviceHealth(): Promise<DeviceHealth> {
  try {
    return await withSSH(async (conn) => {
      const [tfRunning, sbStatusResult, battery, storage] = await Promise.all([
        isTestFlightRunning(conn),
        sendBridgeRequestRawTo(conn, SB_REQUEST_PATH, SB_RESPONSE_PATH, { action: 'screen_status' }, 8_000)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const, value: undefined })),
        queryBatteryStatus(conn).catch((err: unknown) => {
          deviceLog.warn('battery query threw', { error: String(err) });
          return undefined;
        }),
        queryDeviceStorage(conn).catch((err: unknown) => {
          deviceLog.warn('storage query threw', { error: String(err) });
          return undefined;
        }),
      ]);
      const sbStatus = sbStatusResult.value;
      return {
        reachable: true,
        testFlightRunning: tfRunning,
        testFlightBridgeReachable: sbStatusResult.ok,
        darkEnabled: sbStatus?.darkEnabled,
        screenIsOn: sbStatus?.screenIsOn,
        backlightState: sbStatus?.backlightState,
        batteryPercent: battery?.batteryPercent,
        batteryCharging: battery?.batteryCharging,
        batteryTemperatureC: battery?.batteryTemperatureC,
        batteryCycleCount: battery?.batteryCycleCount,
        batteryHealthPercent: battery?.batteryHealthPercent,
        batteryDesignCapacityMah: battery?.batteryDesignCapacityMah,
        batteryMaxCapacityMah: battery?.batteryMaxCapacityMah,
        storageTotalBytes: storage?.totalBytes,
        storageUsedBytes: storage?.usedBytes,
        storageFreeBytes: storage?.freeBytes,
        storageUsedPercent: storage?.usedPercent,
        checkedAt: Date.now(),
      };
    });
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
  }
}

export async function getDeviceHealth(force = false): Promise<DeviceHealth> {
  if (!force && healthCache && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) return healthCache.value;
  const value = await computeDeviceHealth();
  healthCache = { at: Date.now(), value };
  return value;
}

const HEALTH_POLL_INTERVAL_MS = 5 * 60_000;

let unreachableSince: number | undefined;
let offlineAlertSentAt: number | undefined;

async function checkOfflineAlert(reachable: boolean): Promise<void> {
  if (reachable) {
    unreachableSince = undefined;
    offlineAlertSentAt = undefined;
    return;
  }

  if (unreachableSince === undefined) unreachableSince = Date.now();
  if (offlineAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.deviceOfflineAlertMinutes * 60_000;
  if (Date.now() - unreachableSince < thresholdMs) return;

  offlineAlertSentAt = Date.now();
  await notify('deviceOffline', {
    title: 'iDevice unreachable',
    description: `The iDevice has been unreachable for at least ${settings.deviceOfflineAlertMinutes} minutes - decrypts and the scheduler can't run until it's back.`,
    color: EMBED_COLOR.err,
  });
}

let batteryHotAlertSentAt: number | undefined;

async function checkBatteryHotAlert(tempC: number | undefined): Promise<void> {
  if (tempC === undefined) return;
  const settings = getEffectiveSettings();

  if (tempC < settings.batteryHotAlertC - 3) {
    batteryHotAlertSentAt = undefined;
    return;
  }
  if (tempC < settings.batteryHotAlertC || batteryHotAlertSentAt !== undefined) return;

  batteryHotAlertSentAt = Date.now();
  await notify('deviceBatteryHot', {
    title: 'iDevice running hot',
    description: `Battery temperature reached ${tempC.toFixed(1)}°C (alert threshold ${settings.batteryHotAlertC}°C).`,
    color: EMBED_COLOR.warn,
  });
}

let batteryLowAlertSentAt: number | undefined;

async function checkBatteryLowAlert(percent: number | undefined, charging: boolean | undefined): Promise<void> {
  if (percent === undefined) return;
  const settings = getEffectiveSettings();

  if (charging || percent > settings.batteryLowAlertPercent + 5) {
    batteryLowAlertSentAt = undefined;
    return;
  }
  if (percent > settings.batteryLowAlertPercent || batteryLowAlertSentAt !== undefined) return;

  batteryLowAlertSentAt = Date.now();
  await notify('deviceBatteryLow', {
    title: 'iDevice battery low',
    description: `Battery at ${percent}% and not charging (alert threshold ${settings.batteryLowAlertPercent}%).`,
    color: EMBED_COLOR.warn,
  });
}

let deviceStorageAlertSentAt: number | undefined;

async function checkDeviceStorageAlert(usedPercent: number | undefined): Promise<void> {
  if (usedPercent === undefined) return;
  const settings = getEffectiveSettings();
  const percent = usedPercent * 100;

  if (percent < settings.deviceStorageAlertPercent - 5) {
    deviceStorageAlertSentAt = undefined;
    return;
  }
  if (percent < settings.deviceStorageAlertPercent || deviceStorageAlertSentAt !== undefined) return;

  deviceStorageAlertSentAt = Date.now();
  await notify('deviceStorageLow', {
    title: 'iDevice storage running low',
    description: `The iDevice's storage is ${Math.round(percent)}% full (alert threshold ${settings.deviceStorageAlertPercent}%) - decrypts and TestFlight installs need room to work in.`,
    color: EMBED_COLOR.warn,
  });
}

let diskFullAlertSentAt: number | undefined;

// Host-side (OUTPUT_DIR), not the device - piggybacks on this poller's existing 5-minute cadence
// and hysteresis-alert plumbing rather than standing up a separate one just for this.
async function checkDiskFullAlert(): Promise<void> {
  const usage = getDiskUsage(config.outputDir);
  if (!usage) return;
  const settings = getEffectiveSettings();
  const percent = usage.usedPercent * 100;

  if (percent < settings.diskFullAlertPercent - 5) {
    diskFullAlertSentAt = undefined;
    return;
  }
  if (percent < settings.diskFullAlertPercent || diskFullAlertSentAt !== undefined) return;

  diskFullAlertSentAt = Date.now();
  await notify('diskFull', {
    title: 'Staging disk running low',
    description: `${config.outputDir} is ${Math.round(percent)}% full (alert threshold ${settings.diskFullAlertPercent}%) - decrypts will start failing once it fills up.`,
    color: EMBED_COLOR.warn,
  });
}

// Only alerts on a regression from a confirmed-working state, never on "has never once
// responded" - tfauto is an optional companion tweak (see README's TestFlight builds section),
// so a fresh install without it would otherwise get a permanent false alarm every poll.
let bridgeEverReachable = false;
let bridgeUnreachableSince: number | undefined;
let bridgeDownAlertSentAt: number | undefined;

async function checkTestFlightBridgeAlert(reachable: boolean): Promise<void> {
  if (reachable) {
    bridgeEverReachable = true;
    bridgeUnreachableSince = undefined;
    bridgeDownAlertSentAt = undefined;
    return;
  }
  if (!bridgeEverReachable) return;

  if (bridgeUnreachableSince === undefined) bridgeUnreachableSince = Date.now();
  if (bridgeDownAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.testFlightBridgeAlertMinutes * 60_000;
  if (Date.now() - bridgeUnreachableSince < thresholdMs) return;

  bridgeDownAlertSentAt = Date.now();
  await notify('testFlightBridgeDown', {
    title: 'TestFlight bridge unresponsive',
    description: `The tfauto SpringBoard bridge has stopped responding for at least ${settings.testFlightBridgeAlertMinutes} minutes - TestFlight installs and the scheduler's TestFlight watch can't run until it recovers (a respring or tweak crash usually fixes it).`,
    color: EMBED_COLOR.warn,
  });
}

function warnOnMissingTelemetry(health: DeviceHealth): void {
  if (!health.reachable) return;
  const missing = (
    [
      ['testFlightRunning', health.testFlightRunning],
      ['screenIsOn', health.screenIsOn],
      ['batteryPercent', health.batteryPercent],
      ['batteryTemperatureC', health.batteryTemperatureC],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) log.warn('device is reachable but missing expected telemetry fields', { missing });
}

// Independent of whether anyone has the dashboard open (the 20s cache above only gets refreshed
// by an actual dashboard request) - this is what builds the reachability-over-time history.
export function startDeviceHealthPoller(): void {
  const poll = () =>
    void getDeviceHealth()
      .then((health) => {
        warnOnMissingTelemetry(health);
        recordDeviceHealthCheck(
          health.reachable,
          health.batteryPercent,
          health.batteryTemperatureC,
          health.storageUsedPercent !== undefined ? Math.round(health.storageUsedPercent * 100) : undefined,
        );
        return Promise.all([
          checkOfflineAlert(health.reachable),
          checkBatteryHotAlert(health.batteryTemperatureC),
          checkBatteryLowAlert(health.batteryPercent, health.batteryCharging),
          checkDeviceStorageAlert(health.storageUsedPercent),
          checkTestFlightBridgeAlert(health.testFlightBridgeReachable ?? false),
          checkDiskFullAlert(),
        ]);
      })
      .catch((err) => log.warn('device health poll failed', { error: String(err) }));

  poll();
  setInterval(poll, HEALTH_POLL_INTERVAL_MS).unref();
}
