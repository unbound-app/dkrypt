import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'ssh2';
import type { BridgeEnvelope } from './idevice.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION } from './bridgeProtocol.js';

const { armAppStoreAutoConfirm, createBridgeEnvelope, readBridgeHeartbeats } = await import('./idevice.js' + '?idevice-transport-test');

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

test('uses SSH exec channels for device file reads and writes', async () => {
  const { connection, commands, writes } = fakeDeviceConnection();

  await expect(readBridgeHeartbeats(connection)).resolves.toEqual({
    springboard: { process: 'springboard', at: 1 },
    testflight: { process: 'testflight', at: 1 },
    appstore: { process: 'appstore', at: 1 },
  });
  await armAppStoreAutoConfirm(connection, 'Inspect');

  expect(commands).toHaveLength(4);
  expect(commands.every((command) => command.includes('cat'))).toBe(true);
  expect(writes).toEqual(['Inspect']);
});
