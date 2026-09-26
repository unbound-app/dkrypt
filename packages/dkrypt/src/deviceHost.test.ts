import { expect, test } from 'bun:test';
import { isSupportedDeviceHost } from '#deviceHost.js';

test('accepts DNS, IPv4, and IPv6 device hosts', () => {
  expect(isSupportedDeviceHost('ipad.local')).toBe(true);
  expect(isSupportedDeviceHost('device_name.local')).toBe(true);
  expect(isSupportedDeviceHost('192.168.1.10')).toBe(true);
  expect(isSupportedDeviceHost('2001:db8::10')).toBe(true);
});

test('rejects malformed or oversized device hosts', () => {
  expect(isSupportedDeviceHost('')).toBe(false);
  expect(isSupportedDeviceHost('bad/host')).toBe(false);
  expect(isSupportedDeviceHost('999.999.999.999')).toBe(false);
  expect(isSupportedDeviceHost('a'.repeat(254))).toBe(false);
});
