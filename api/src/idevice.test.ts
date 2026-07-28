import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createBridgeEnvelope, type BridgeEnvelope } from './idevice.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION } from './bridgeProtocol.js';

test('createBridgeEnvelope matches the shared bridge fixture', async () => {
  const fixturePath = path.resolve(import.meta.dir, '../../packages/autoinstall/protocol/bridge-v1.fixture.json');
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
