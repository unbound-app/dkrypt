import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'ssh2';
import type { BridgeEnvelope } from './idevice.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION } from './bridgeProtocol.js';

const { armAppStoreAutoConfirm, buildIpadecryptRuntimeConfig, createBridgeEnvelope, execCommand, readBridgeHeartbeats, retryTransientSshConnection } = await import('./idevice.js' + '?idevice-transport-test');

type FakeExecStream = {
  stderr: {
    on(event: 'data', listener: (chunk: Buffer) => void): void;
  };
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  end(input?: string): void;
  sendData(chunk: Buffer): void;
  finish(code: number): void;
};

function fakeDeviceConnection(): { connection: Client; commands: string[]; writes: string[] } {
  const commands: string[] = [];
  const writes: string[] = [];
  const connection = {
    exec(command: string, callback: (error: Error | undefined, stream: FakeExecStream) => void) {
      commands.push(command);
      let outputHandler: ((chunk: Buffer) => void) | undefined;
      let closeHandler: ((code: number | null) => void) | undefined;
      const stream = {
        stderr: {
          on(_event: 'data', _listener: (chunk: Buffer) => void) {},
        },
        on(event: 'data' | 'error' | 'close', listener: ((chunk: Buffer) => void) | ((error: Error) => void) | ((code: number | null) => void)) {
          if (event === 'data') outputHandler = listener as (chunk: Buffer) => void;
          if (event === 'close') closeHandler = listener as (code: number | null) => void;
        },
        sendData(chunk: Buffer) {
          outputHandler?.(chunk);
        },
        finish(code: number) {
          closeHandler?.(code);
        },
        end(input = '') {
          writes.push(input);
          closeHandler?.(0);
        },
      } as unknown as FakeExecStream;
      callback(undefined, stream);
      if (command.startsWith('cat >')) return;
      const channel = command.match(/\/tmp\/autoinstall\/v1\/([^/]+)\//)?.[1] ?? 'unknown';
      stream.sendData(Buffer.from(JSON.stringify({ process: channel, at: 1 })));
      stream.finish(0);
    },
  } as unknown as Client;
  return { connection, commands, writes };
}

test('createBridgeEnvelope matches the shared bridge fixture', async () => {
  const fixturePath = path.resolve(import.meta.dir, '../../autoinstall/protocol/bridge-v1.fixture.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    secret: string;
    channel: 'testflight';
    request: Record<string, unknown>;
    requestId: string;
    issuedAt: number;
    envelope: BridgeEnvelope;
    contract: { version: number; springboard: readonly string[]; testflight: readonly string[]; appstore: readonly string[] };
  };
  const envelope = createBridgeEnvelope(fixture.secret, fixture.channel, fixture.request, fixture.requestId, fixture.issuedAt);

  expect(envelope).toEqual(fixture.envelope);
  expect(createBridgeEnvelope(fixture.secret, 'appstore', fixture.request, fixture.requestId, fixture.issuedAt).signature).not.toBe(envelope.signature);
  expect(fixture.contract).toEqual({ version: BRIDGE_PROTOCOL_VERSION, ...BRIDGE_CAPABILITIES });
});

test('uses SSH exec channels for device file reads and quoted writes', async () => {
  const { connection, commands, writes } = fakeDeviceConnection();

  await expect(readBridgeHeartbeats(connection)).resolves.toEqual({
    springboard: { process: 'springboard', at: 1 },
    testflight: { process: 'testflight', at: 1 },
    appstore: { process: 'appstore', at: 1 },
  });
  await armAppStoreAutoConfirm(connection, 'Inspect');

  expect(commands).toHaveLength(4);
  expect(commands.slice(0, 3).every((command) => command.includes('cat'))).toBe(true);
  expect(commands[3]).toContain('printf');
  expect(commands[3]).toContain('Inspect');
  expect(writes).toEqual([]);
});

test('times out stalled SSH exec channels', async () => {
  const connection = { exec() {} } as unknown as Client;

  await expect(execCommand(connection, 'stalled command', 20)).resolves.toEqual({
    stdout: '',
    stderr: 'command timed out after 20ms',
    code: null,
  });
});

test('retries transient SSH handshakes before failing', async () => {
  let attempts = 0;

  await expect(retryTransientSshConnection(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Timed out while waiting for handshake');
    return 'ready';
  }, 1, 0)).resolves.toBe('ready');

  expect(attempts).toBe(2);
});

test('creates an ipadecrypt runtime config without requiring bootstrap credentials', () => {
  const config = JSON.parse(buildIpadecryptRuntimeConfig({ host: '127.0.0.1', port: 2222, user: 'mobile', keyPath: '/root/.ssh/id_ed25519' })) as {
    version: number;
    apple?: { email?: string; password?: string };
    device?: { host?: string; port?: number; user?: string; auth?: { kind?: string; keyPath?: string } };
  };

  expect(config).toMatchObject({
    version: 2,
    apple: { email: 'managed-device@dkrypt.invalid' },
    device: { host: '127.0.0.1', port: 2222, user: 'mobile', auth: { kind: 'key', keyPath: '/root/.ssh/id_ed25519' } },
  });
  expect(config.apple?.password).toBeUndefined();
});
