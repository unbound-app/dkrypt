import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from 'bun:test';

const entrypoint = readFileSync(path.resolve(import.meta.dir, '../entrypoint.sh'), 'utf8');
const dockerfile = readFileSync(path.resolve(import.meta.dir, '../Dockerfile'), 'utf8');
const compose = readFileSync(path.resolve(import.meta.dir, '../../../docker-compose.yml'), 'utf8');
const deploymentWorkflow = readFileSync(path.resolve(import.meta.dir, '../../../.github/workflows/deploy.yml'), 'utf8');
const composeUpCommand = 'DKRYPT_IMAGE="$IMAGE" docker compose --env-file /home/adrian/.local/share/dkrypt/.env --project-name dkrypt -f /home/adrian/.local/share/dkrypt/compose.yml up -d --no-build';

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

test('a dedicated Ed25519 SSH key persists independently of host credentials', () => {
  expect(entrypoint).toContain('ssh-keygen -q -t ed25519 -N');
  expect(entrypoint).toContain('DEVICE_SSH_KEY_PATH must be stored in DEVICE_SSH_KEY_DIR');
  expect(entrypoint).toContain('chown 10001:10001 "$ssh_key_path"');
  expect(entrypoint).toContain('chown 10001:10001 "$ssh_public_key_path"');
  expect(entrypoint).toContain('chmod 0400 "$ssh_key_path"');
  expect(entrypoint).toContain('chmod 0440 "$ssh_public_key_path"');
  expect(entrypoint.indexOf('chmod 0400 "$ssh_key_path"')).toBeLessThan(entrypoint.indexOf("ssh-keygen -y -P '' -f \"$ssh_key_path\""));
  expect(dockerfile).toContain('openssh-client');
  expect(compose).toContain('      - device-ssh:/data/device-ssh');
  expect(compose).toContain('  device-ssh:\n    external: true\n    name: dkrypt_device_ssh');
  expect(deploymentWorkflow).toContain('                - device-ssh:/data/device-ssh');
  expect(deploymentWorkflow).toContain('docker volume inspect dkrypt_device_ssh');
  expect(deploymentWorkflow).toContain('name: dkrypt_device_ssh');
  expect(deploymentWorkflow).toContain("process.env.DEVICE_SSH_KEY_PATH || '/data/device-ssh/id_ed25519'");
  expect(deploymentWorkflow).toContain("process.env.DEVICE_SSH_PUBLIC_KEY_PATH || '/data/device-ssh/id_ed25519.pub'");
  expect(deploymentWorkflow).toContain('"Name":"dkrypt_device_ssh"');
  expect(deploymentWorkflow).toContain('key.uid !== 10001 || key.gid !== 10001 || (key.mode & 0o777) !== 0o400');
  expect(deploymentWorkflow).toContain('publicKey.uid !== 10001 || publicKey.gid !== 10001 || (publicKey.mode & 0o777) !== 0o440');
  expect(deploymentWorkflow).toContain('host SSH identity is unexpectedly mounted into dkrypt');
  expect(compose).not.toContain('DEVICE_SSH_KEY_HOST_PATH');
  expect(deploymentWorkflow).not.toContain('DEVICE_SSH_KEY_HOST_PATH');
  expect(deploymentWorkflow).not.toContain('RUNTIME_HOME/.ssh/id_');
});

test('production verifies database migration and restore before replacing the running container', () => {
  const preflightIndex = deploymentWorkflow.indexOf('src/deploymentPreflight.ts');
  const volumeCheckIndex = deploymentWorkflow.indexOf('docker volume inspect dkrypt_state >/dev/null');
  const replaceIndex = deploymentWorkflow.indexOf(composeUpCommand);
  expect(preflightIndex).toBeGreaterThan(-1);
  expect(volumeCheckIndex).toBeGreaterThan(-1);
  expect(volumeCheckIndex).toBeLessThan(preflightIndex);
  expect(preflightIndex).toBeLessThan(replaceIndex);
  expect(deploymentWorkflow).toContain('--network none');
  expect(deploymentWorkflow).toContain('--mount type=volume,source=dkrypt_state,target=/data/state,readonly');
  expect(deploymentWorkflow).toContain('--tmpfs /tmp:rw,nosuid,size=1g,uid=10001,gid=10001');
});

test('production replaces the container through Compose graceful shutdown', () => {
  expect(deploymentWorkflow).toContain('stop_grace_period: 30s');
  expect(deploymentWorkflow).not.toContain('docker rm -f dkrypt');
  expect(deploymentWorkflow).toContain(composeUpCommand);
});

test('production verifies persistent storage as the already-unprivileged smoke-test user', () => {
  const smokeStart = deploymentWorkflow.indexOf('const artifactProbePath =');
  const smokeEnd = deploymentWorkflow.indexOf('const { config }', smokeStart);
  const storageProbe = deploymentWorkflow.slice(smokeStart, smokeEnd);
  expect(storageProbe).toContain('await Bun.write(artifactProbePath, artifactProbeContent)');
  expect(storageProbe).not.toContain('spawnSync');
  expect(storageProbe).not.toContain('setpriv');
});

test('persistent shared volumes can replace legacy root-owned files after rollback', () => {
  expect(entrypoint).toContain('.dkrypt-api-access-v2');
  expect(entrypoint).toContain('chmod 2770 "$volume_dir"');
  expect(entrypoint).not.toContain('chmod 3770 "$volume_dir"');
});

test('the bridge secret is available only to the API service identity', () => {
  expect(entrypoint).toContain('chown 10001:10001 "$secret_file"');
  expect(entrypoint).toContain('chmod 0400 "$secret_file"');
  expect(entrypoint).not.toContain('chown 0:0 "$secret_file"');
});

test('production smoke verifies the saved Rust pairing, USB agent, and decrypt SFTP setup', () => {
  const pairingVerification = deploymentWorkflow.indexOf('await verifyRustDevicePairing(primaryDevice)');
  const agentProbe = deploymentWorkflow.indexOf('withAutoinstallDeviceAgent(primaryDevice');
  const decryptSetup = deploymentWorkflow.indexOf('await setupDeviceConnection(primaryDevice)');
  expect(pairingVerification).toBeGreaterThan(-1);
  expect(agentProbe).toBeGreaterThan(-1);
  expect(decryptSetup).toBeGreaterThan(-1);
  expect(pairingVerification).toBeLessThan(agentProbe);
  expect(agentProbe).toBeLessThan(decryptSetup);
  expect(deploymentWorkflow).toContain("client.call('status', {}, 3_000)");
  expect(deploymentWorkflow).toContain('device setup did not verify decrypt readiness');
  expect(deploymentWorkflow).toContain("step.id === 'ssh_sftp' && step.status === 'ready'");
  expect(deploymentWorkflow).toContain('docker exec -i --user 10001:10001');
  expect(deploymentWorkflow).not.toContain('process.kill(');
});
