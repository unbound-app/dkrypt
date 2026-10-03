import { expect, test } from 'bun:test';
import { evaluateAutoinstallVersion, supportedCompatibility } from '#compatibility.js';

test('compatibility policy accepts supported semantic Autoinstall versions', () => {
  expect(supportedCompatibility.autoinstallMinimum).toBe('1.4.0');
  expect(evaluateAutoinstallVersion('1.4.0')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.4.0-rc.1')).toBe('unsupported');
  expect(evaluateAutoinstallVersion('1.4.4')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.5.0')).toBe('supported');
  expect(evaluateAutoinstallVersion('1.3.9')).toBe('unsupported');
  expect(evaluateAutoinstallVersion('2.0.0')).toBe('unsupported');
  expect(evaluateAutoinstallVersion(undefined)).toBe('unknown');
  expect(evaluateAutoinstallVersion('not-a-version')).toBe('unknown');
});
