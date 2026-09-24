import { expect, test } from 'bun:test';
import { runConfigurationDoctor } from '#doctor.js';

test('configuration doctor reports runtime security and persistence checks', async () => {
  const result = await runConfigurationDoctor();
  const ids = new Set(result.checks.map((check) => check.id));
  expect(ids.has('database')).toBe(true);
  expect(ids.has('session-secret')).toBe(true);
  expect(ids.has('public-url')).toBe(true);
  expect(ids.has('runtime-limits')).toBe(true);
  expect(ids.has('device-bridge')).toBe(true);
  expect(ids.has('otel')).toBe(true);
});
