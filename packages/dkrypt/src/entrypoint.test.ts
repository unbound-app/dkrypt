import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';

const entrypoint = readFileSync(path.resolve(import.meta.dir, '../entrypoint.sh'), 'utf8');

test('every device bridge launch retains the API socket group access', () => {
  const launchCommands = entrypoint
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/usr/local/bin/dkrypt-device-bridge'));
  expect(launchCommands.length).toBeGreaterThan(0);
  expect(launchCommands.every((command) => /^setpriv --regid=10001 --clear-groups \/usr\/local\/bin\/dkrypt-device-bridge &$/.test(command))).toBe(true);
});
