import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';

const entrypoint = readFileSync(path.resolve(import.meta.dir, '../entrypoint.sh'), 'utf8');
const compose = readFileSync(path.resolve(import.meta.dir, '../../../docker-compose.yml'), 'utf8');

test('every device bridge launch runs with USB access and API socket group access', () => {
  const launchCommands = entrypoint
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/usr/local/bin/dkrypt-device-bridge'));
  expect(launchCommands.length).toBeGreaterThan(0);
  expect(launchCommands.every((command) => /^setpriv --regid=10001 --keep-groups \/usr\/local\/bin\/dkrypt-device-bridge &$/.test(command))).toBe(true);
  const apiCommand = entrypoint.split('\n').map((line) => line.trim()).find((line) => line.includes('bun src/server.ts'));
  expect(apiCommand).toMatch(/^setpriv --reuid=10001 --regid=10001 --clear-groups bun src\/server\.ts &$/);
});

test('Compose binds the USB bus directory and permits USB character devices', () => {
  expect(compose).toContain('      - /dev/bus/usb:/dev/bus/usb');
  expect(compose).toContain("    device_cgroup_rules:\n      - 'c 189:* rwm'");
  expect(compose).not.toMatch(/^\s*devices:\s*$/m);
});
