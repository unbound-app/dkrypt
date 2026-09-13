import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Client } from 'ssh2';
import { armAppStoreAutoConfirm, createBridgeEnvelope, readBridgeHeartbeats, type BridgeEnvelope } from './idevice.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION } from './bridgeProtocol.js';

type FakeExecStream = EventEmitter & {
  stderr: EventEmitter;
  end(input?: string): void;
};

function fakeDeviceConnection(): { connection: Client; commands: string[]; writes: string[] } {
  const commands: string[] = [];
  const writes: string[] = [];
  const connection = {
    exec(command: string, callback: (error: Error | undefined, stream: FakeExecStream) => void) {
      commands.push(command);
      const stream = new EventEmitter() as FakeExecStream;
      stream.stderr = new EventEmitter();
      stream.end = (input = '') => {
        writes.push(input);
        queueMicrotask(() => stream.emit('close', 0));
      };
      callback(undefined, stream);
      if (command.includes('cat >')) return;
      const channel = command.match(/\/tmp\/autoinstall\/v1\/([^/]+)\//)?.[1] ?? 'unknown';
      queueMicrotask(() => {
        stream.emit('data', Buffer.from(JSON.stringify({ process: channel, at: 1 })));
        stream.emit('close', 0);
      });
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
