import { describe, expect, test } from 'bun:test';
import { getAppleDeviceKind, getAppleDeviceModelName } from '#lib/deviceModel';

describe('Apple device metadata', () => {
  test('recognizes the discovered iPad and resolves its marketing model', () => {
    expect(getAppleDeviceKind('iPad7,11')).toBe('ipad');
    expect(getAppleDeviceModelName('iPad7,11')).toBe('iPad (7th generation)');
  });

  test('recognizes iPhone identifiers and falls back to the product family', () => {
    expect(getAppleDeviceKind('iPhone18,1')).toBe('iphone');
    expect(getAppleDeviceModelName('iPhone18,1')).toBe('iPhone');
  });

  test('uses a device name when hardware metadata has not been stored yet', () => {
    expect(getAppleDeviceKind(undefined, "Adrian's iPad")).toBe('ipad');
    expect(getAppleDeviceModelName(undefined, "Adrian's iPad")).toBe('iPad');
  });
});
