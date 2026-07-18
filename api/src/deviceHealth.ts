import { Client } from 'ssh2';
import { config } from './config.js';
import { execCommand, isTestFlightRunning, sendSpringBoardBridgeRequest, tryIoregCandidates, withSSH } from './idevice.js';
import { scopedLogger } from './logger.js';
import { EMBED_COLOR, notify } from './notify.js';
import { getEffectiveSettings, recordDeviceHealthCheck } from './store/state.js';
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
let healthCache: { at: number; value: DeviceHealth } | undefined;

async function computeDeviceHealth(): Promise<DeviceHealth> {
  try {
    return await withSSH(async (conn) => {
      const [tfRunning, sbStatusResult, battery, storage] = await Promise.all([
        isTestFlightRunning(conn),
        sendSpringBoardBridgeRequest(conn, { action: 'screen_status' }, 8_000)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const, value: undefined })),
        queryBatteryStatus(conn).catch((err: unknown) => {
          log.warn('battery query threw', { error: String(err) });
          return undefined;
        }),
        queryDeviceStorage(conn).catch((err: unknown) => {
          log.warn('storage query threw', { error: String(err) });
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
