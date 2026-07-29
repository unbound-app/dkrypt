import { Client } from 'ssh2';
import { config } from '#config.js';
import { execCommand, isTestFlightRunning, readBridgeHeartbeats, sendSpringBoardBridgeRequest, tryIoregCandidates, withSSH, type BridgeHeartbeat } from '#idevice.js';
import { scopedLogger } from '#logger.js';
import { EMBED_COLOR, notify } from '#notify.js';
import { releasePinnedJobsForDevice } from '#jobs/store.js';
import { getEffectiveDevices, getEffectiveSettings, recordDeviceActivity, recordDeviceHealthCheck, type DeviceRecord } from '#store/state.js';
import { getDiskUsage } from '#util/diskUsage.js';
import { getCachedDeviceHealth, setCachedDeviceHealth } from '#deviceHealthCache.js';

const log = scopedLogger('idevice');

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
  networkConnected?: boolean;
  internetAccess?: boolean;
  networkIpAddress?: string;
  networkInterface?: string;
  bridgeHeartbeats?: Partial<Record<'springboard' | 'testflight' | 'appstore', BridgeHeartbeat>>;
  readiness?: DeviceReadiness;
  checkedAt: number;
}

export interface DeviceReadiness {
  score: number;
  state: 'ready' | 'caution' | 'blocked';
  reasons: string[];
}

const BRIDGE_HEARTBEAT_MAX_AGE_MS = 90_000;
const INSTALL_STORAGE_SAFETY_MULTIPLIER = 2;

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function isBridgeHeartbeatFresh(heartbeat: BridgeHeartbeat | undefined, now = Date.now()): boolean {
  return typeof heartbeat?.at === 'number' && now - heartbeat.at * 1000 <= BRIDGE_HEARTBEAT_MAX_AGE_MS;
}

export function getDeviceInstallBlocker(health: DeviceHealth, installSizeBytes?: number): string | undefined {
  if (!health.reachable) return health.error ?? 'device is unreachable';
  if (health.internetAccess === false) return 'device cannot reach Apple services';
  if (health.testFlightBridgeReachable === false) return 'autoinstall bridge is unresponsive';
  if (health.bridgeHeartbeats?.springboard && !isBridgeHeartbeatFresh(health.bridgeHeartbeats.springboard)) return 'autoinstall SpringBoard heartbeat is stale';
  if (health.batteryPercent !== undefined && !health.batteryCharging && health.batteryPercent < 15) return `device battery is ${health.batteryPercent}% and not charging`;
  if (health.batteryTemperatureC !== undefined && health.batteryTemperatureC >= 45) return `device temperature is ${health.batteryTemperatureC.toFixed(1)}°C`;
  const normalizedInstallSizeBytes = typeof installSizeBytes === 'number' && Number.isFinite(installSizeBytes) && installSizeBytes > 0 ? installSizeBytes : undefined;
  if (
    health.storageFreeBytes !== undefined &&
    normalizedInstallSizeBytes !== undefined &&
    health.storageFreeBytes < normalizedInstallSizeBytes * INSTALL_STORAGE_SAFETY_MULTIPLIER
  ) {
    const requiredBytes = normalizedInstallSizeBytes * INSTALL_STORAGE_SAFETY_MULTIPLIER;
    return `device has ${formatGigabytes(health.storageFreeBytes)} free storage; install needs ${formatGigabytes(requiredBytes)} (2× build size)`;
  }
  return undefined;
}

export function getDeviceReadiness(health: DeviceHealth): DeviceReadiness {
  const reasons: string[] = [];
  let score = 100;
  if (!health.reachable) {
    return { score: 0, state: 'blocked', reasons: ['device is unreachable'] };
  }
  if (health.internetAccess === false) {
    score -= 50;
    reasons.push('no internet access');
  }
  if (health.testFlightBridgeReachable === false) {
    score -= 50;
    reasons.push('autoinstall bridge is unresponsive');
  }
  if (health.bridgeHeartbeats?.springboard && !isBridgeHeartbeatFresh(health.bridgeHeartbeats.springboard)) {
    score -= 50;
    reasons.push('autoinstall SpringBoard heartbeat is stale');
  }
  if (health.batteryPercent !== undefined && !health.batteryCharging && health.batteryPercent < 15) {
    score -= 20;
    reasons.push(`battery is ${health.batteryPercent}% and not charging`);
  }
  if (health.batteryTemperatureC !== undefined && health.batteryTemperatureC >= 45) {
    score -= 25;
    reasons.push(`battery is ${health.batteryTemperatureC.toFixed(1)}°C`);
  }
  if (health.storageUsedPercent !== undefined && health.storageUsedPercent >= 0.95) {
    score -= 25;
    reasons.push(`storage is ${Math.round(health.storageUsedPercent * 100)}% full`);
  }
  score = Math.max(0, score);
  return { score, state: score >= 80 ? 'ready' : score >= 55 ? 'caution' : 'blocked', reasons };
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

const IOREG_CANDIDATES = ['ioreg', '/usr/sbin/ioreg', '/cores/binpack/usr/sbin/ioreg', '/cores/binpack/usr/bin/ioreg'];
const IOREG_BATTERY_CLASS = 'AppleARMPMUCharger';

async function runIoreg(conn: Client): Promise<string | undefined> {
  return tryIoregCandidates(conn, IOREG_BATTERY_CLASS, IOREG_CANDIDATES);
}

async function queryBatteryStatus(conn: Client): Promise<BatteryStatus | undefined> {
  const stdout = await runIoreg(conn);
  if (!stdout) {
    log.warn('ioreg is not available on the device via any known path - battery telemetry disabled');
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
    log.warn('ioreg output did not contain the expected AppleARMPMUCharger fields', { sample: stdout.slice(0, 500) });
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

export function parseDeviceStorageDf(stdout: string): DeviceStorage | undefined {
  const lines = stdout.trim().split('\n').filter(Boolean);
  let parsed: { totalKb: number; freeKb: number } | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const match = line.match(/(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%(?:\s|$)/);
    if (!match) continue;
    parsed = {
      totalKb: Number(match[1]),
      freeKb: Number(match[3]),
    };
    break;
  }

  if (!parsed) return undefined;

  const totalBytes = parsed.totalKb * 1024;
  const freeBytes = parsed.freeKb * 1024;
  const usedBytes = totalBytes - freeBytes;
  if (
    !Number.isFinite(totalBytes) ||
    !Number.isFinite(usedBytes) ||
    !Number.isFinite(freeBytes) ||
    totalBytes <= 0 ||
    freeBytes < 0 ||
    freeBytes > totalBytes
  ) {
    return undefined;
  }

  return { totalBytes, usedBytes, freeBytes, usedPercent: usedBytes / totalBytes };
}

async function queryDeviceStorage(conn: Client): Promise<DeviceStorage | undefined> {
  const { stdout, code } = await execCommand(conn, 'df -k /private/var 2>&1');
  if (code !== 0) {
    log.warn('device storage df query failed', { code, output: stdout.slice(0, 200) });
    return undefined;
  }

  const storage = parseDeviceStorageDf(stdout);
  if (!storage) {
    log.warn('device storage df output did not contain parseable numbers', { sample: stdout.slice(-200) });
  }
  return storage;
}

interface NetworkStatus {
  networkConnected: boolean;
  internetAccess?: boolean;
  ipAddress?: string;
  networkInterface?: string;
}

const IFCONFIG_CANDIDATES = ['ifconfig', '/sbin/ifconfig', '/var/jb/sbin/ifconfig', '/cores/binpack/sbin/ifconfig'];

const CAPTIVE_CHECK_URL = 'http://captive.apple.com/hotspot-detect.html';

async function runIfconfig(conn: Client): Promise<string | undefined> {
  for (const bin of IFCONFIG_CANDIDATES) {
    const { stdout, code } = await execCommand(conn, `${bin} 2>/dev/null`);
    if (code === 0 && stdout.includes('inet ')) return stdout;
  }
  return undefined;
}

function parsePrimaryIPv4(ifconfigOutput: string): { ipAddress: string; iface: string } | undefined {
  let currentIface = '';
  for (const line of ifconfigOutput.split('\n')) {
    const ifaceMatch = line.match(/^([a-z0-9]+):\s/i);
    if (ifaceMatch) {
      currentIface = ifaceMatch[1];
      continue;
    }
    const inetMatch = line.match(/^\s+inet (\d+\.\d+\.\d+\.\d+)/);
    if (!inetMatch) continue;
    const ip = inetMatch[1];
    if (currentIface === 'lo0' || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
    return { ipAddress: ip, iface: currentIface };
  }
  return undefined;
}

async function queryNetworkStatus(conn: Client): Promise<NetworkStatus | undefined> {
  const ifconfigOutput = await runIfconfig(conn);
  if (!ifconfigOutput) {
    log.warn('ifconfig is not available on the device via any known path - network telemetry disabled');
    return undefined;
  }

  const primary = parsePrimaryIPv4(ifconfigOutput);
  if (!primary) return { networkConnected: false };

  const { stdout, code } = await execCommand(conn, `curl -s --max-time 6 ${CAPTIVE_CHECK_URL} 2>/dev/null`);
  const internetAccess = code === 0 && /Success/i.test(stdout);
  return { networkConnected: true, internetAccess, ipAddress: primary.ipAddress, networkInterface: primary.iface };
}

const HEALTH_CACHE_TTL_MS = 20_000;

async function computeDeviceHealth(device: DeviceRecord, isPrimary: boolean): Promise<DeviceHealth> {
  try {
    return await withSSH(device.rootDir, async (conn) => {
      const [tfRunning, sbStatusResult, battery, storage, network, bridgeHeartbeats] = await Promise.all([
        isTestFlightRunning(conn),
        isPrimary
          ? sendSpringBoardBridgeRequest(conn, { action: 'screen_status' }, 8_000)
              .then((value) => ({ ok: true as const, value }))
              .catch(() => ({ ok: false as const, value: undefined }))
          : Promise.resolve({ ok: false as const, value: undefined }),
        queryBatteryStatus(conn).catch((err: unknown) => {
          log.warn('battery query threw', { deviceId: device.id, error: String(err) });
          return undefined;
        }),
        queryDeviceStorage(conn).catch((err: unknown) => {
          log.warn('storage query threw', { deviceId: device.id, error: String(err) });
          return undefined;
        }),
        queryNetworkStatus(conn).catch((err: unknown) => {
          log.warn('network query threw', { deviceId: device.id, error: String(err) });
          return undefined;
        }),
        readBridgeHeartbeats(conn),
      ]);
      const sbStatus = sbStatusResult.value;
      const health: DeviceHealth = {
        reachable: true,
        testFlightRunning: tfRunning,
        testFlightBridgeReachable: isPrimary ? sbStatusResult.ok : undefined,
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
        networkConnected: network?.networkConnected,
        internetAccess: network?.internetAccess,
        networkIpAddress: network?.ipAddress,
        networkInterface: network?.networkInterface,
        bridgeHeartbeats,
        checkedAt: Date.now(),
      };
      return { ...health, readiness: getDeviceReadiness(health) };
    });
  } catch (err) {
    const health: DeviceHealth = { reachable: false, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
    return { ...health, readiness: getDeviceReadiness(health) };
  }
}

function isPrimaryDeviceId(deviceId: string): boolean {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];
  return primary?.id === deviceId;
}

export function peekPrimaryDeviceHealth(): DeviceHealth | undefined {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];
  if (!primary) return undefined;
  return getCachedDeviceHealth(primary.id)?.value;
}

export async function getDeviceHealth(deviceId: string, force = false): Promise<DeviceHealth> {
  const cached = getCachedDeviceHealth(deviceId);
  if (!force && cached && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) return cached.value;
  const device = getEffectiveDevices().find((d) => d.id === deviceId);
  if (!device) return { reachable: false, error: 'device not found', checkedAt: Date.now() };
  const value = await computeDeviceHealth(device, isPrimaryDeviceId(deviceId));
  setCachedDeviceHealth(deviceId, value);
  return value;
}

const HEALTH_POLL_INTERVAL_MS = 5 * 60_000;

interface DeviceAlertState {
  unreachableSince?: number;
  offlineAlertSentAt?: number;
  batteryHotAlertSentAt?: number;
  batteryLowAlertSentAt?: number;
  deviceStorageAlertSentAt?: number;
  bridgeEverReachable: boolean;
  bridgeUnreachableSince?: number;
  bridgeDownAlertSentAt?: number;
}

const alertStates = new Map<string, DeviceAlertState>();
const lastActivityState = new Map<string, { reachable: boolean; bridgeReachable?: boolean }>();

function alertStateFor(deviceId: string): DeviceAlertState {
  let s = alertStates.get(deviceId);
  if (!s) {
    s = { bridgeEverReachable: false };
    alertStates.set(deviceId, s);
  }
  return s;
}

async function checkOfflineAlert(device: DeviceRecord, reachable: boolean): Promise<void> {
  const s = alertStateFor(device.id);
  if (reachable) {
    s.unreachableSince = undefined;
    s.offlineAlertSentAt = undefined;
    return;
  }

  if (s.unreachableSince === undefined) {
    s.unreachableSince = Date.now();
    releasePinnedJobsForDevice(device.id);
  }
  if (s.offlineAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.deviceOfflineAlertMinutes * 60_000;
  if (Date.now() - s.unreachableSince < thresholdMs) return;

  s.offlineAlertSentAt = Date.now();
  await notify('deviceOffline', {
    title: 'iDevice unreachable',
    description: `${device.name} has been unreachable for at least ${settings.deviceOfflineAlertMinutes} minutes - decrypts assigned to it can't run until it's back.`,
    color: EMBED_COLOR.err,
  });
}

async function checkBatteryHotAlert(device: DeviceRecord, tempC: number | undefined): Promise<void> {
  if (tempC === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();

  if (tempC < settings.batteryHotAlertC - 3) {
    s.batteryHotAlertSentAt = undefined;
    return;
  }
  if (tempC < settings.batteryHotAlertC || s.batteryHotAlertSentAt !== undefined) return;

  s.batteryHotAlertSentAt = Date.now();
  await notify('deviceBatteryHot', {
    title: 'iDevice running hot',
    description: `${device.name}'s battery temperature reached ${tempC.toFixed(1)}°C (alert threshold ${settings.batteryHotAlertC}°C).`,
    color: EMBED_COLOR.warn,
  });
}

async function checkBatteryLowAlert(device: DeviceRecord, percent: number | undefined, charging: boolean | undefined): Promise<void> {
  if (percent === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();

  if (charging || percent > settings.batteryLowAlertPercent + 5) {
    s.batteryLowAlertSentAt = undefined;
    return;
  }
  if (percent > settings.batteryLowAlertPercent || s.batteryLowAlertSentAt !== undefined) return;

  s.batteryLowAlertSentAt = Date.now();
  await notify('deviceBatteryLow', {
    title: 'iDevice battery low',
    description: `${device.name}'s battery is at ${percent}% and not charging (alert threshold ${settings.batteryLowAlertPercent}%).`,
    color: EMBED_COLOR.warn,
  });
}

async function checkDeviceStorageAlert(device: DeviceRecord, usedPercent: number | undefined): Promise<void> {
  if (usedPercent === undefined) return;
  const s = alertStateFor(device.id);
  const settings = getEffectiveSettings();
  const percent = usedPercent * 100;

  if (percent < settings.deviceStorageAlertPercent - 5) {
    s.deviceStorageAlertSentAt = undefined;
    return;
  }
  if (percent < settings.deviceStorageAlertPercent || s.deviceStorageAlertSentAt !== undefined) return;

  s.deviceStorageAlertSentAt = Date.now();
  await notify('deviceStorageLow', {
    title: 'iDevice storage running low',
    description: `${device.name}'s storage is ${Math.round(percent)}% full (alert threshold ${settings.deviceStorageAlertPercent}%) - decrypts and TestFlight installs need room to work in.`,
    color: EMBED_COLOR.warn,
  });
}

let diskFullAlertSentAt: number | undefined;

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

async function checkTestFlightBridgeAlert(device: DeviceRecord, reachable: boolean): Promise<void> {
  const s = alertStateFor(device.id);
  if (reachable) {
    s.bridgeEverReachable = true;
    s.bridgeUnreachableSince = undefined;
    s.bridgeDownAlertSentAt = undefined;
    return;
  }
  if (!s.bridgeEverReachable) return;

  if (s.bridgeUnreachableSince === undefined) s.bridgeUnreachableSince = Date.now();
  if (s.bridgeDownAlertSentAt !== undefined) return;

  const settings = getEffectiveSettings();
  const thresholdMs = settings.testFlightBridgeAlertMinutes * 60_000;
  if (Date.now() - s.bridgeUnreachableSince < thresholdMs) return;

  s.bridgeDownAlertSentAt = Date.now();
  await notify('testFlightBridgeDown', {
    title: 'TestFlight bridge unresponsive',
    description: `The autoinstall SpringBoard bridge on ${device.name} has stopped responding for at least ${settings.testFlightBridgeAlertMinutes} minutes - TestFlight installs and the scheduler's TestFlight watch can't run until it recovers (a respring or tweak crash usually fixes it).`,
    color: EMBED_COLOR.warn,
  });
}

function warnOnMissingTelemetry(device: DeviceRecord, health: DeviceHealth): void {
  if (!health.reachable) return;
  const missing = (
    [
      ['testFlightRunning', health.testFlightRunning],
      ['batteryPercent', health.batteryPercent],
      ['batteryTemperatureC', health.batteryTemperatureC],
    ] as const
  )
    .filter(([, value]) => value === undefined)
    .map(([key]) => key);
  if (missing.length > 0) log.warn('device is reachable but missing expected telemetry fields', { deviceId: device.id, missing });
}

async function pollOneDevice(device: DeviceRecord, isPrimary: boolean): Promise<void> {
  const health = await computeDeviceHealth(device, isPrimary);
  setCachedDeviceHealth(device.id, health);
  warnOnMissingTelemetry(device, health);
  recordDeviceHealthCheck(
    device.id,
    health.reachable,
    health.batteryPercent,
    health.batteryTemperatureC,
    health.storageUsedPercent !== undefined ? Math.round(health.storageUsedPercent * 100) : undefined,
  );
  const previous = lastActivityState.get(device.id);
  if (!previous || previous.reachable !== health.reachable) {
    recordDeviceActivity({ deviceId: device.id, kind: 'health', message: health.reachable ? 'Device became reachable' : 'Device became unreachable' });
  }
  if (isPrimary && health.testFlightBridgeReachable !== undefined && previous?.bridgeReachable !== health.testFlightBridgeReachable) {
    recordDeviceActivity({
      deviceId: device.id,
      kind: 'bridge',
      message: health.testFlightBridgeReachable ? 'autoinstall bridge became available' : 'autoinstall bridge became unavailable',
    });
  }
  lastActivityState.set(device.id, { reachable: health.reachable, bridgeReachable: health.testFlightBridgeReachable });
  await Promise.all([
    checkOfflineAlert(device, health.reachable),
    checkBatteryHotAlert(device, health.batteryTemperatureC),
    checkBatteryLowAlert(device, health.batteryPercent, health.batteryCharging),
    checkDeviceStorageAlert(device, health.storageUsedPercent),
    ...(isPrimary ? [checkTestFlightBridgeAlert(device, health.testFlightBridgeReachable ?? false)] : []),
  ]);
}

export function startDeviceHealthPoller(): void {
  const poll = async () => {
    const devices = getEffectiveDevices().filter((d) => d.enabled);
    const primary = devices.find((d) => d.isPrimary) ?? devices[0];
    await Promise.all(devices.map((d) => pollOneDevice(d, d.id === primary?.id).catch((err) => log.warn('device health poll failed', { deviceId: d.id, error: String(err) }))));
    await checkDiskFullAlert().catch((err) => log.warn('disk full check failed', { error: String(err) }));
  };

  void poll();
  setInterval(() => void poll(), HEALTH_POLL_INTERVAL_MS).unref();
}
