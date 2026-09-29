import type { Database } from 'bun:sqlite';
import type { DeviceRecord } from '#store/state.js';

export interface DeviceRepository {
  listAll(): DeviceRecord[];
  findById(id: string): DeviceRecord | undefined;
  create(record: DeviceRecord): DeviceRecord[];
  update(id: string, patch: Partial<DeviceRecord>): DeviceRecord[] | undefined;
  delete(id: string): { changed: boolean; devices: DeviceRecord[] };
}

export function createDeviceRepository(database: Database): DeviceRepository {
  const listAllQuery = database.query('SELECT payload FROM devices ORDER BY rowid ASC;');
  const findByIdQuery = database.query('SELECT payload FROM devices WHERE id = ?;');
  const deleteAllQuery = database.query('DELETE FROM devices;');
  const insertQuery = database.query('INSERT INTO devices (id, payload, updated_at) VALUES (?, ?, ?);');

  function listAll(): DeviceRecord[] {
    return (listAllQuery.all() as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as DeviceRecord);
  }

  function findById(id: string): DeviceRecord | undefined {
    const row = findByIdQuery.get(id) as { payload: string } | null;
    return row ? JSON.parse(row.payload) as DeviceRecord : undefined;
  }

  function normalizePrimary(devices: DeviceRecord[], preferredId?: string): DeviceRecord[] {
    const primary = devices.find((device) => device.enabled && device.id === preferredId)
      ?? devices.find((device) => device.enabled && device.isPrimary)
      ?? devices.find((device) => device.enabled);
    return devices.map((device) => ({ ...device, isPrimary: device.id === primary?.id }));
  }

  function persist(devices: DeviceRecord[]): void {
    deleteAllQuery.run();
    for (const device of devices) insertQuery.run(device.id, JSON.stringify(device), device.updatedAt);
  }

  function transact<T>(operation: () => T): T {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const result = operation();
      database.exec('COMMIT;');
      return result;
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  return {
    listAll,
    findById,
    create(record) {
      return transact(() => {
        const devices = listAll();
        const nextDevices = normalizePrimary([...devices, record], record.isPrimary ? record.id : undefined);
        persist(nextDevices);
        return nextDevices;
      });
    },
    update(id, patch) {
      return transact(() => {
        const devices = listAll();
        const index = devices.findIndex((device) => device.id === id);
        if (index < 0) return undefined;
        devices[index] = { ...devices[index]!, ...patch };
        const preferredId = patch.isPrimary === true && devices[index]!.enabled ? id : undefined;
        const nextDevices = normalizePrimary(devices, preferredId);
        persist(nextDevices);
        return nextDevices;
      });
    },
    delete(id) {
      return transact(() => {
        const devices = listAll();
        const nextDevices = devices.filter((device) => device.id !== id);
        if (nextDevices.length === devices.length) return { changed: false, devices };
        const normalizedDevices = normalizePrimary(nextDevices);
        persist(normalizedDevices);
        return { changed: true, devices: normalizedDevices };
      });
    },
  };
}
