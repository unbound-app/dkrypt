import { expect, test } from 'bun:test';
import { serializeDashboardDevice } from '#dashboardDevicePresentation.js';
import { createDevice, deleteDevice } from '#store/state.js';

test('includes cached device bridge heartbeats in dashboard device records', () => {
  const device = createDevice({ name: 'Heartbeat device', host: '192.168.1.10' }, 'test');
  try {
    const serialized = serializeDashboardDevice(device, {
      reachable: true,
      checkedAt: Date.now(),
      capabilities: ['agent', 'list_devices'],
      agentHeartbeatAt: 1_790_000_001,
      bridgeHeartbeats: { springboard: { at: 1_790_000_000, bridgeVersion: '1.2.0', channel: 'springboard' } },
    });
    expect(serialized.transportCapabilities).toEqual(['agent', 'list_devices']);
    expect(serialized.agentHeartbeatAt).toBe(1_790_000_001);
    expect(serialized.bridgeHeartbeats).toEqual({
      springboard: { at: 1_790_000_000, bridgeVersion: '1.2.0', channel: 'springboard' },
    });
  } finally {
    deleteDevice(device.id, 'test');
  }
});
