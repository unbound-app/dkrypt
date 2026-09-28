import type { DeviceHealth } from '#deviceHealth.js';

const BRIDGE_HEARTBEAT_MAX_AGE_MS = 90_000;
const INSTALL_STORAGE_SAFETY_MULTIPLIER = 2;

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function isBridgeHeartbeatFresh(heartbeat: { at?: number } | undefined, now = Date.now()): boolean {
  return typeof heartbeat?.at === 'number' && now - heartbeat.at * 1000 <= BRIDGE_HEARTBEAT_MAX_AGE_MS;
}

export type DeviceInstallSource = 'appstore' | 'testflight';

export function getDeviceSourceBlocker(health: DeviceHealth, source: DeviceInstallSource): string | undefined {
  if (health.testFlightBridgeReachable === false) return 'autoinstall SpringBoard bridge is unresponsive';

  const sourceHealth = source === 'appstore'
    ? { label: 'App Store', subsystem: health.subsystems?.appStore, heartbeat: health.bridgeHeartbeats?.appstore }
    : { label: 'TestFlight', subsystem: health.subsystems?.testFlight, heartbeat: health.bridgeHeartbeats?.testflight };

  if (sourceHealth.subsystem === 'degraded' || sourceHealth.subsystem === 'offline' || sourceHealth.subsystem === 'unsupported') {
    return `${sourceHealth.label} subsystem is ${sourceHealth.subsystem}`;
  }
  if (sourceHealth.heartbeat && !isBridgeHeartbeatFresh(sourceHealth.heartbeat)) return `${sourceHealth.label} bridge heartbeat is stale`;
  return undefined;
}

export function getDeviceInstallBlocker(health: DeviceHealth, installSizeBytes?: number, source?: DeviceInstallSource): string | undefined {
  if (!health.reachable) return health.error ?? 'device is unreachable';
  if (health.subsystems?.agent === 'offline') return 'device agent is unavailable while the USB transport is still connected';
  if (health.subsystems?.sshTunnel === 'degraded' || health.subsystems?.sshTunnel === 'offline') return 'device SSH/SFTP tunnel is unavailable for decrypt';
  if (health.internetAccess === false) return 'device cannot reach Apple services';
  const sourceBlocker = source ? getDeviceSourceBlocker(health, source) : undefined;
  if (sourceBlocker) return sourceBlocker;
  if (!source && health.testFlightBridgeReachable === false) return 'autoinstall SpringBoard bridge is unresponsive';
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
