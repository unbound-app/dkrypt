import { randomUUID } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import type { DeviceConnection, DeviceSetupResult } from '#idevice.js';

export interface DeviceSetupOperationInput {
  connection: Omit<DeviceConnection, 'keyPath'>;
  name?: string;
  existingId?: string;
  productType?: string;
  iosVersion?: string;
  toolchain?: string;
  notes?: string;
}

export interface DeviceSetupOperation {
  id: string;
  ownerId: string;
  input: DeviceSetupOperationInput;
  status: 'queued' | 'running' | 'interrupted' | 'complete' | 'failed';
  stage: string;
  stages: Array<{ id: string; label: string; at: number; status: 'running' | 'complete' | 'failed' }>;
  deviceId?: string;
  ready?: boolean;
  setup?: DeviceSetupResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export function createDeviceSetupOperationRepository(database: Database) {
  const read = database.query('SELECT payload FROM device_setup_operations WHERE id = ?');
  const write = database.query('INSERT INTO device_setup_operations (id, payload, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at');
  const fromRow = (row: { payload: string } | null): DeviceSetupOperation | undefined => row ? JSON.parse(row.payload) as DeviceSetupOperation : undefined;
  const get = (id: string): DeviceSetupOperation | undefined => fromRow(read.get(id) as { payload: string } | null);
  const persist = (operation: DeviceSetupOperation): DeviceSetupOperation => {
    operation.updatedAt = Math.max(Date.now(), operation.updatedAt + 1);
    write.run(operation.id, JSON.stringify(operation), operation.updatedAt);
    return operation;
  };
  return {
    create(ownerId: string, input: DeviceSetupOperationInput): DeviceSetupOperation {
      const now = Date.now();
      const { keyPath: _keyPath, ...connection } = input.connection as DeviceConnection;
      return persist({ id: randomUUID(), ownerId, input: { ...input, connection }, status: 'queued', stage: 'queued', stages: [], createdAt: now, updatedAt: now - 1 });
    },
    get,
    list(ownerId: string, limit = 25): DeviceSetupOperation[] {
      const rows = database.query('SELECT payload FROM device_setup_operations WHERE json_extract(payload, \'$.ownerId\') = ? ORDER BY updated_at DESC LIMIT ?').all(ownerId, limit) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as DeviceSetupOperation);
    },
    advance(id: string, stage: string, label: string): DeviceSetupOperation | undefined {
      const operation = get(id);
      if (!operation || operation.status === 'complete') return operation;
      const at = Date.now();
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'complete';
      operation.status = 'running';
      operation.stage = stage;
      operation.error = undefined;
      operation.stages.push({ id: stage, label, at, status: 'running' });
      return persist(operation);
    },
    complete(id: string, result: { deviceId: string; ready: boolean; setup?: DeviceSetupResult }): DeviceSetupOperation | undefined {
      const operation = get(id);
      if (!operation || operation.status === 'complete') return operation;
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'complete';
      operation.status = 'complete';
      operation.stage = 'complete';
      operation.deviceId = result.deviceId;
      operation.ready = result.ready;
      operation.setup = result.setup;
      operation.completedAt = Date.now();
      return persist(operation);
    },
    fail(id: string, message: string): DeviceSetupOperation | undefined {
      const operation = get(id);
      if (!operation || operation.status === 'complete') return operation;
      const previous = operation.stages.at(-1);
      if (previous?.status === 'running') previous.status = 'failed';
      operation.status = 'failed';
      operation.error = message;
      operation.completedAt = Date.now();
      return persist(operation);
    },
    interruptRunning(): number {
      const rows = database.query("SELECT payload FROM device_setup_operations WHERE json_extract(payload, '$.status') IN ('queued', 'running')").all() as Array<{ payload: string }>;
      for (const row of rows) {
        const operation = JSON.parse(row.payload) as DeviceSetupOperation;
        operation.status = 'interrupted';
        operation.error = 'Setup was interrupted. Reconnect the device and resume setup.';
        persist(operation);
      }
      return rows.length;
    },
    resume(id: string): DeviceSetupOperation | undefined {
      const operation = get(id);
      if (!operation || !['interrupted', 'failed'].includes(operation.status)) return undefined;
      operation.status = 'queued';
      operation.error = undefined;
      operation.completedAt = undefined;
      return persist(operation);
    },
    close(): void {
      database.close();
    },
  };
}
