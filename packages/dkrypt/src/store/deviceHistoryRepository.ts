import type { Database } from 'bun:sqlite';
import type { DeviceActivityEntry } from '#store/state.js';

export interface DeviceHistoryRepository {
  listByDevice(deviceId: string): DeviceActivityEntry[];
}

export function createDeviceHistoryRepository(database: Database): DeviceHistoryRepository {
  const statement = database.query('SELECT payload FROM device_history WHERE device_id = ? ORDER BY occurred_at DESC, id DESC;');
  return {
    listByDevice(deviceId) {
      const rows = statement.all(deviceId) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as DeviceActivityEntry);
    },
  };
}
