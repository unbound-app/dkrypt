import { describe, expect, test } from 'bun:test';
import { getDeviceReadiness, type DeviceHealth } from '#deviceHealth.js';

function health(overrides: Partial<DeviceHealth> = {}): DeviceHealth {
  return { reachable: true, checkedAt: 0, ...overrides };
}

describe('getDeviceReadiness', () => {
  test('keeps a healthy device ready', () => {
    expect(getDeviceReadiness(health())).toEqual({ score: 100, state: 'ready', reasons: [] });
  });

  test('blocks automation when the device loses internet or bridge access', () => {
    expect(getDeviceReadiness(health({ internetAccess: false })).state).toBe('blocked');
    expect(getDeviceReadiness(health({ testFlightBridgeReachable: false })).state).toBe('blocked');
  });
});
