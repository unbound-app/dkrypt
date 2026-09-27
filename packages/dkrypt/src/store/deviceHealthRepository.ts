import type { Database } from 'bun:sqlite';
import type { DeviceHealthCheck } from '#store/state.js';

export interface DeviceHealthRepository {
  listByDevice(deviceId: string): DeviceHealthCheck[];
}

export function createDeviceHealthRepository(database: Database): DeviceHealthRepository {
  const statement = database.query('SELECT payload FROM device_health WHERE device_id = ? ORDER BY checked_at DESC, id DESC;');
  return {
    listByDevice(deviceId) {
      const rows = statement.all(deviceId) as Array<{ payload: string }>;
      return rows.map((row) => {
        const check = JSON.parse(row.payload) as DeviceHealthCheck;
        return {
          ts: check.ts,
          reachable: check.reachable,
          batteryPercent: check.batteryPercent,
          batteryTemperatureC: check.batteryTemperatureC,
          storageUsedPercent: check.storageUsedPercent,
        };
      });
    },
  };
}
