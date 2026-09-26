import { config } from '#config.js';
import { getCachedDeviceHealth } from '#deviceHealthCache.js';
import type { DeviceRecord } from '#store/state.js';

export function serializeDashboardDevice(deviceRecord: DeviceRecord, health = getCachedDeviceHealth(deviceRecord.id)?.value) {
  const { keyPath: _keyPath, ...device } = deviceRecord;
  return {
    ...device,
    transport: deviceRecord.transport ?? 'wifi',
    port: deviceRecord.port ?? config.deviceSshPort,
    user: deviceRecord.user ?? config.deviceSshUser,
    setupRequired: !deviceRecord.host && !deviceRecord.udid,
    transportState: health?.transportState ?? 'discovered',
    transportCapabilities: health?.capabilities ?? [],
    lastSeenAt: health?.lastSeenAt,
    recoveryState: health?.recoveryState ?? 'recovering',
    ...(health?.bridgeHeartbeats ? { bridgeHeartbeats: health.bridgeHeartbeats } : {}),
  };
}
