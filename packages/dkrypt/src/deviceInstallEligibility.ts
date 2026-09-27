import type { DeviceHealth } from '#deviceHealth.js';

const BRIDGE_HEARTBEAT_MAX_AGE_MS = 90_000;
const INSTALL_STORAGE_SAFETY_MULTIPLIER = 2;

function formatGigabytes(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function isBridgeHeartbeatFresh(heartbeat: { at?: number } | undefined, now = Date.now()): boolean {
  return typeof heartbeat?.at === 'number' && now - heartbeat.at * 1000 <= BRIDGE_HEARTBEAT_MAX_AGE_MS;
}

export function getDeviceInstallBlocker(health: DeviceHealth, installSizeBytes?: number): string | undefined {
  if (!health.reachable) return health.error ?? 'device is unreachable';
  if (health.subsystems?.agent === 'offline') return 'device agent is unavailable while the USB transport is still connected';
  if (health.subsystems?.sshTunnel === 'degraded' || health.subsystems?.sshTunnel === 'offline') return 'device SSH/SFTP tunnel is unavailable for decrypt';
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
