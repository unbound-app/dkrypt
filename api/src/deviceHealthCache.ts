import type { DeviceHealth } from '#deviceHealth.js';

interface CachedDeviceHealth {
  at: number;
  value: DeviceHealth;
}

const deviceHealthCache = new Map<string, CachedDeviceHealth>();

export function getCachedDeviceHealth(deviceId: string): CachedDeviceHealth | undefined {
  return deviceHealthCache.get(deviceId);
}

export function setCachedDeviceHealth(deviceId: string, value: DeviceHealth): void {
  deviceHealthCache.set(deviceId, { at: Date.now(), value });
}
