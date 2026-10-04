import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeviceSetupOperationRepository } from '#store/deviceSetupOperationRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('device setup progress survives restart and interrupted work can resume', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-device-setup-'));
  temporaryDirectories.push(stateDir);
  const first = createDeviceSetupOperationRepository(openStateCollectionDatabase({ stateDir }, ['device_setup_operations']));
  const created = first.create('manager', { connection: { transport: 'usb', udid: '1234567890' }, name: 'My iPad' });
  first.advance(created.id, 'connecting', 'Connecting to the device');
  first.close();

  const second = createDeviceSetupOperationRepository(openStateCollectionDatabase({ stateDir }, ['device_setup_operations']));
  try {
    expect(second.interruptRunning()).toBe(1);
    expect(second.get(created.id)?.status).toBe('interrupted');
    expect(second.list('manager')[0]?.stage).toBe('connecting');
    expect(second.list('other')).toEqual([]);
    const resumed = second.resume(created.id);
    expect(resumed?.status).toBe('queued');
    second.complete(created.id, { deviceId: 'device-1', ready: true });
    expect(second.get(created.id)).toMatchObject({ status: 'complete', deviceId: 'device-1', ready: true });
  } finally {
    second.close();
  }
});
