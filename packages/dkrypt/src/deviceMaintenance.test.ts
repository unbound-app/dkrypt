import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { setCachedDeviceHealth } from '#deviceHealthCache.js';
import { getDeviceHealth } from '#deviceHealth.js';
import { getMaintenanceStatus } from '#maintenance.js';
import { createDevice, deleteDevice, getEffectiveSettings, recordDeviceHealthCheck, updateSettings } from '#store/state.js';

function recordHealthChecksAt(deviceId: string, timestamps: number[]): void {
  for (const timestamp of timestamps) {
    const originalNow = Date.now;
    Date.now = () => timestamp;
    try {
      recordDeviceHealthCheck(deviceId, false);
    } finally {
      Date.now = originalNow;
    }
  }
}

test('transient forced device probes do not automatically pause decrypts', async () => {
  const suffix = randomUUID();
  const now = Date.now();
  const originalMaintenanceMode = getEffectiveSettings().maintenanceMode;
  const device = createDevice({
    name: `Transient probe ${suffix}`,
    transport: 'wifi',
    host: '127.0.0.1',
    port: 1,
    user: 'mobile',
    isPrimary: true,
  }, 'test');
  updateSettings({ maintenanceMode: false }, 'test');
  recordHealthChecksAt(device.id, [now - 90 * 60_000, now - 85 * 60_000, now - 80 * 60_000]);

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) await getDeviceHealth(device.id, true);

    expect(getMaintenanceStatus()).toMatchObject({ active: false, manual: false, auto: false });

    recordHealthChecksAt(device.id, [now]);
    setCachedDeviceHealth(device.id, { reachable: false, checkedAt: Date.now() });
    expect(getMaintenanceStatus()).toMatchObject({ active: false, manual: false, auto: false });

    recordHealthChecksAt(device.id, [now - 10 * 60_000, now - 5 * 60_000]);
    setCachedDeviceHealth(device.id, { reachable: false, checkedAt: Date.now() });

    expect(getMaintenanceStatus()).toMatchObject({ active: true, manual: false, auto: true });
  } finally {
    updateSettings({ maintenanceMode: originalMaintenanceMode }, 'test');
    deleteDevice(device.id, 'test');
  }
});
