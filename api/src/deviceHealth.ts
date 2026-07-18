import { Client } from 'ssh2';
import { config } from './config.js';
import { execCommand, isTestFlightRunning, sendSpringBoardBridgeRequest, tryIoregCandidates, withSSH } from './idevice.js';
import { scopedLogger } from './logger.js';
import { EMBED_COLOR, notify } from './notify.js';
import { getEffectiveDevices, getEffectiveSettings, recordDeviceHealthCheck, type DeviceRecord } from './store/state.js';
import { getDiskUsage } from './util/diskUsage.js';

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

async function queryDeviceStorage(conn: Client): Promise<DeviceStorage | undefined> {
  const { stdout, code } = await execCommand(conn, 'df -k /private/var 2>&1');
  if (code !== 0) {
    log.warn('device storage df query failed', { code, output: stdout.slice(0, 200) });
    return undefined;
  }

  const lines = stdout.trim().split('\n').filter(Boolean);
  let parsed: { totalKb: number; usedKb: number; freeKb: number } | undefined;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    const match = line.match(/(?:^|\s)(\d+)\s+(\d+)\s+(\d+)\s+\d+%(?:\s|$)/);
    if (!match) continue;
    parsed = {
      totalKb: Number(match[1]),
      usedKb: Number(match[2]),
      freeKb: Number(match[3]),
    };
    break;
  }

  if (!parsed) {
    log.warn('device storage df output did not contain expected numeric columns', {
      sample: lines[lines.length - 1]?.slice(0, 200),
    });
    return undefined;
  }

  const totalBytes = parsed.totalKb * 1024;
  const usedBytes = parsed.usedKb * 1024;
  const freeBytes = parsed.freeKb * 1024;
  if (!Number.isFinite(totalBytes) || !Number.isFinite(usedBytes) || !Number.isFinite(freeBytes) || totalBytes <= 0) {
    log.warn('device storage df output did not contain parseable numbers', {
      sample: lines[lines.length - 1]?.slice(0, 200),
    });
    return undefined;
  }

  return { totalBytes, usedBytes, freeBytes, usedPercent: usedBytes / totalBytes };
}

const HEALTH_CACHE_TTL_MS = 20_000;
const healthCache = new Map<string, { at: number; value: DeviceHealth }>();

// The SpringBoard bridge (screen status, dark mode, TestFlight bridge reachability) is only
// queried for the primary device - tfauto only ever targets one physical device at a time, so
// asking a non-primary device for bridge status would just measure whether tfauto happens to
// also be installed there, not anything meaningful about that device's own health.
async function computeDeviceHealth(device: DeviceRecord, isPrimary: boolean): Promise<DeviceHealth> {
  try {
    return await withSSH(device.rootDir, async (conn) => {
      const [tfRunning, sbStatusResult, battery, storage] = await Promise.all([
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
      ]);
      const sbStatus = sbStatusResult.value;
      return {
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
        checkedAt: Date.now(),
      };
    });
  } catch (err) {
    return { reachable: false, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
  }
}

function isPrimaryDeviceId(deviceId: string): boolean {
  const devices = getEffectiveDevices().filter((d) => d.enabled);
  const primary = devices.find((d) => d.isPrimary) ?? devices[0];
  return primary?.id === deviceId;
}

export async function getDeviceHealth(deviceId: string, force = false): Promise<DeviceHealth> {
  const cached = healthCache.get(deviceId);
  if (!force && cached && Date.now() - cached.at < HEALTH_CACHE_TTL_MS) return cached.value;
  const device = getEffectiveDevices().find((d) => d.id === deviceId);
  if (!device) return { reachable: false, error: 'device not found', checkedAt: Date.now() };
  const value = await computeDeviceHealth(device, isPrimaryDeviceId(deviceId));
  healthCache.set(deviceId, { at: Date.now(), value });
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

  if (s.unreachableSince === undefined) s.unreachableSince = Date.now();
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

// Watches the server's own staging disk (OUTPUT_DIR), not any particular iDevice's storage -
// stays a single global check rather than one per device, since it has nothing to do with
// which iDevice is being polled.
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
    description: `The tfauto SpringBoard bridge on ${device.name} has stopped responding for at least ${settings.testFlightBridgeAlertMinutes} minutes - TestFlight installs and the scheduler's TestFlight watch can't run until it recovers (a respring or tweak crash usually fixes it).`,
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
  healthCache.set(device.id, { at: Date.now(), value: health });
  warnOnMissingTelemetry(device, health);
  recordDeviceHealthCheck(
    device.id,
    health.reachable,
    health.batteryPercent,
    health.batteryTemperatureC,
    health.storageUsedPercent !== undefined ? Math.round(health.storageUsedPercent * 100) : undefined,
  );
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
