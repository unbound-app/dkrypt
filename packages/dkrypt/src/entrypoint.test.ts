import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';

const entrypoint = readFileSync(path.resolve(import.meta.dir, '../entrypoint.sh'), 'utf8');
const dockerfile = readFileSync(path.resolve(import.meta.dir, '../Dockerfile'), 'utf8');
const compose = readFileSync(path.resolve(import.meta.dir, '../../../docker-compose.yml'), 'utf8');
const deploymentWorkflow = readFileSync(path.resolve(import.meta.dir, '../../../.github/workflows/deploy.yml'), 'utf8');

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
  expect(deploymentWorkflow).toContain('                - /dev/bus/usb:/dev/bus/usb');
  expect(deploymentWorkflow).toContain("              device_cgroup_rules:\n                - 'c 189:* rwm'");
  expect(deploymentWorkflow).not.toContain('              devices:\n                - /dev/bus/usb:/dev/bus/usb');
});

test('USB bridge startup does not require an SSH key', () => {
  expect(entrypoint).toContain('if [ -s "$ssh_key_source" ]; then');
  expect(dockerfile).toContain('RUN touch /device-ssh-key-source && chmod 0600 /device-ssh-key-source');
  expect(compose).toContain('${DEVICE_SSH_KEY_HOST_PATH:-/dev/null}:/device-ssh-key-source:ro');
  expect(deploymentWorkflow).toContain('${DEVICE_SSH_KEY_HOST_PATH:-/dev/null}:/device-ssh-key-source:ro');
  expect(deploymentWorkflow).toContain('configured_key_path=$(awk');
  expect(deploymentWorkflow).toContain('DEVICE_SSH_KEY_HOST_PATH="$configured_key_path"');
  expect(deploymentWorkflow.indexOf('configured_key_path=$(awk')).toBeLessThan(deploymentWorkflow.indexOf('existing_key_path=$(docker inspect'));
  expect(deploymentWorkflow).toContain('DEVICE_SSH_KEY_HOST_PATH=/dev/null');
  expect(deploymentWorkflow).toContain('if (!key.isFile() || key.size === 0 || key.uid !== 0 || key.gid !== 10001 || (key.mode & 0o777) !== 0o440)');
  expect(deploymentWorkflow).toContain('let sshKeyAvailable = false;');
  expect(deploymentWorkflow).not.toContain('No SSH key source configured for the dkrypt compatibility channel');
});

test('production verifies database migration and restore before replacing the running container', () => {
  const preflightIndex = deploymentWorkflow.indexOf('src/deploymentPreflight.ts');
  const volumeCheckIndex = deploymentWorkflow.indexOf('docker volume inspect dkrypt_state >/dev/null');
  const stopIndex = deploymentWorkflow.indexOf('docker rm -f dkrypt');
  expect(preflightIndex).toBeGreaterThan(-1);
  expect(volumeCheckIndex).toBeGreaterThan(-1);
  expect(volumeCheckIndex).toBeLessThan(preflightIndex);
  expect(preflightIndex).toBeLessThan(stopIndex);
  expect(deploymentWorkflow).toContain('--network none');
  expect(deploymentWorkflow).toContain('--mount type=volume,source=dkrypt_state,target=/data/state,readonly');
  expect(deploymentWorkflow).toContain('--tmpfs /tmp:rw,nosuid,size=1g,uid=10001,gid=10001');
});
