import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from 'ssh2';
import type { BridgeEnvelope, DeviceClient, DeviceSession } from './idevice.js';
import { config } from '#config.js';
import { BRIDGE_CAPABILITIES, BRIDGE_PROTOCOL_VERSION, TESTFLIGHT_LIFECYCLE_CAPABILITIES } from './bridgeProtocol.js';

const { armAppStoreAutoConfirm, buildIpadecryptRuntimeConfig, clearAppStoreAutoConfirm, createBridgeEnvelope, createDeviceAgentEnvelope, execCommand, getDeviceAgentRetryDelay, getDeviceTransportOrder, isDirectUsbDeviceAgentConnection, readBridgeHeartbeats, retryRustDeviceHealthProbe, retryTransientSshConnection, sendAppStoreBridgeRequest, withSSH } = await import('./idevice.js' + '?idevice-transport-test');

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

function signedAgentResponse(secret: string, requestId: string, result: Record<string, unknown>): Record<string, unknown> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ ok: true, result })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`dkrypt-autoinstall-agent-response-v1|${requestId}|${issuedAt}|${payload}`).digest('hex');
  return { version: 1, requestId, issuedAt, payload, signature };
}

function writeFrame(socket: import('node:net').Socket, value: Record<string, unknown>): void {
  const body = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  socket.end(frame);
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
    contract: { version: number; springboard: readonly string[]; testflight: readonly string[]; testflightLifecycle: readonly string[]; appstore: readonly string[] };
  };
  const envelope = createBridgeEnvelope(fixture.secret, fixture.channel, fixture.request, fixture.requestId, fixture.issuedAt);

  expect(envelope).toEqual(fixture.envelope);
  expect(createBridgeEnvelope(fixture.secret, 'appstore', fixture.request, fixture.requestId, fixture.issuedAt).signature).not.toBe(envelope.signature);
  expect(fixture.contract).toEqual({ version: BRIDGE_PROTOCOL_VERSION, ...BRIDGE_CAPABILITIES, testflightLifecycle: TESTFLIGHT_LIFECYCLE_CAPABILITIES });
});

test('createDeviceAgentEnvelope matches the shared bridge fixture', async () => {
  const fixturePath = path.resolve(import.meta.dir, '../../device-bridge/fixtures/device-agent-v1.fixture.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as {
    secret: string;
    request: Record<string, unknown>;
    requestId: string;
    issuedAt: number;
    envelope: Record<string, unknown> & { payload: string };
  };
  const envelope = createDeviceAgentEnvelope(fixture.secret, fixture.requestId, fixture.request, fixture.issuedAt);

  expect(envelope).toEqual(fixture.envelope);
  expect(JSON.parse(Buffer.from(envelope.payload, 'base64url').toString('utf8'))).toEqual(fixture.request);
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
  expect(commands[3]).toMatch(/expiresAtMs=\d+/);
  expect(commands[3]).toContain('Inspect');
  expect(writes).toEqual([]);
});

test('clears App Store auto-confirm flags from every injected service cache', async () => {
  const { connection, commands } = fakeDeviceConnection();

  await clearAppStoreAutoConfirm(connection);

  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain('/tmp/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.PassbookUIService/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.AuthKitUIService/autoinstall-autoconfirm.flag');
  expect(commands[0]).toContain('com.apple.ios.StoreKitUIService/autoinstall-autoconfirm.flag');
});

test('times out stalled SSH exec channels', async () => {
  const connection = { exec() {} } as unknown as Client;

  await expect(execCommand(connection, 'stalled command', 20)).resolves.toEqual({
    stdout: '',
    stderr: 'command timed out after 20ms',
    code: null,
  });
});

test('aborts an in-flight SSH exec channel when the job signal is cancelled', async () => {
  const controller = new AbortController();
  let destroyed = false;
  const connection = {
    exec(_command: string, callback: (error: Error | undefined, stream: FakeExecStream) => void) {
      callback(undefined, {
        stderr: { on() {} },
        on() {},
        destroy() { destroyed = true; },
      } as unknown as FakeExecStream);
    },
  } as unknown as Client;
  const operation = execCommand(connection, 'blocked remote command', 60_000, controller.signal);
  controller.abort(new Error('job deadline exceeded'));

  await expect(operation).rejects.toThrow('job deadline exceeded');
  expect(destroyed).toBe(true);
});

test('removes a bridge request if publishing it is interrupted after the rename', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-bridge-request-cleanup-'));
  const controller = new AbortController();
  let requestPublished = false;
  let requestRemoved = false;
  const client: DeviceSession = {
    transport: 'autoinstall',
    rootDir: runtimeDir,
    async exec(command) {
      if (command.startsWith('mv ') && command.includes('/appstore/requests/')) {
        requestPublished = true;
        controller.abort(new Error('job deadline exceeded'));
        throw controller.signal.reason;
      }
      if (command.startsWith('rm -f') && command.includes('/appstore/requests/') && !command.includes('.partial')) requestRemoved = true;
      return { stdout: '', stderr: '', code: 0 };
    },
    close() {},
  };

  try {
    await expect(sendAppStoreBridgeRequest(client, { action: 'install' }, 20_000, controller.signal)).rejects.toThrow('job deadline exceeded');
    expect(requestPublished).toBe(true);
    expect(requestRemoved).toBe(true);
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
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

test('retries a USB transport that closes before the SSH handshake', async () => {
  let attempts = 0;

  await expect(retryTransientSshConnection(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Connection lost before handshake');
    return 'ready';
  }, 1, 0)).resolves.toBe('ready');

  expect(attempts).toBe(2);
});

test('stops transient SSH handshake retries when the job is aborted', async () => {
  const controller = new AbortController();
  let attempts = 0;
  const connecting = retryTransientSshConnection(async () => {
    attempts += 1;
    throw new Error('Connection reset by peer');
  }, 5, 60_000, controller.signal);

  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort(new Error('job deadline exceeded'));

  await expect(connecting).rejects.toThrow('job deadline exceeded');
  expect(attempts).toBe(1);
});

test('cancels a pending Rust device-agent request when a running job is aborted', async () => {
  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-device-agent-cancel-'));
  const socketPath = path.join(runtimeDir, 'bridge.sock');
  const secret = '0123456789abcdef0123456789abcdef';
  const originalSocket = config.deviceBridgeSocket;
  const originalSecret = config.deviceBridgeSecret;
  const originalRuntimeDir = config.deviceRuntimeDir;
  let resolveExecRequest: ((requestId: string) => void) | undefined;
  let resolveCleanupRequest: ((requestId: string) => void) | undefined;
  let resolveCancellation: ((requestId: string) => void) | undefined;
  const execRequest = new Promise<string>((resolve) => { resolveExecRequest = resolve; });
  const cleanupRequest = new Promise<string>((resolve) => { resolveCleanupRequest = resolve; });
  const cancellation = new Promise<string>((resolve) => { resolveCancellation = resolve; });
  const requests: string[] = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      input = Buffer.concat([input, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      while (input.length >= 4) {
        const length = input.readUInt32BE(0);
        if (input.length < length + 4) break;
        const request = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
        input = input.subarray(length + 4);
        requests.push(String(request.operation));
        const requestId = String(request.requestId);
        const reply = (result: Record<string, unknown>) => writeFrame(socket, { version: 1, requestId, ok: true, result });
        if (request.operation === 'capabilities') {
          reply({ protocolVersion: 1, capabilities: ['agent', 'cancel'] });
        } else if (request.operation === 'agent') {
          const envelope = request.payload as Record<string, unknown>;
          const message = JSON.parse(Buffer.from(String(envelope.payload), 'base64url').toString('utf8')) as Record<string, unknown>;
          requests.push(`agent:${String(message.action)}`);
          if (message.action === 'status') {
            reply(signedAgentResponse(String(request.agentSecret), String(envelope.requestId), { agentVersion: '1.0.0' }));
          } else if (message.action === 'exec') {
            if (message.command === 'sleep 30') {
              resolveExecRequest?.(requestId);
            } else {
              resolveCleanupRequest?.(requestId);
              reply(signedAgentResponse(String(request.agentSecret), String(envelope.requestId), { stdout: '', stderr: '', code: 0 }));
            }
          }
        } else if (request.operation === 'cancel') {
          const targetRequestId = String(request.payload);
          resolveCancellation?.(targetRequestId);
          reply({ cancelled: true, requestId: targetRequestId });
        }
      }
    });
  });

  config.deviceBridgeSocket = socketPath;
  config.deviceBridgeSecret = secret;
  config.deviceRuntimeDir = runtimeDir;
  const controller = new AbortController();

  try {
    await new Promise<void>((resolve, reject) => server.listen(socketPath, resolve).once('error', reject));
    const operation = withSSH(
      { transport: 'usb', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' },
      async (client: DeviceClient) => {
        const session = client as DeviceSession;
        try {
          return await session.exec('sleep 30', 5_000);
        } finally {
          await session.exec('clear auto-confirm', 1_000);
        }
      },
      controller.signal,
    );
    const operationOutcome = operation.then(
      () => 'resolved',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    const requestId = await Promise.race([
      execRequest,
      operationOutcome.then((outcome: string) => { throw new Error(`device-agent operation ${outcome}; requests=${requests.join(',')}`); }),
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for exec; requests=${requests.join(',')}`)), 2_000)),
    ]);
    controller.abort(new Error('job deadline exceeded'));

    await expect(operation).rejects.toThrow('job deadline exceeded');
    await expect(Promise.race([
      cancellation,
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for cancel; requests=${requests.join(',')}`)), 2_000)),
    ])).resolves.toBe(requestId);
    await expect(Promise.race([
      cleanupRequest,
      new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error(`timed out waiting for cleanup; requests=${requests.join(',')}`)), 2_000)),
    ])).resolves.not.toBe(requestId);
  } finally {
    controller.abort(new Error('test cleanup'));
    config.deviceBridgeSocket = originalSocket;
    config.deviceBridgeSecret = originalSecret;
    config.deviceRuntimeDir = originalRuntimeDir;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

test('identifies direct USB connections that can recover without SSH', () => {
  expect(isDirectUsbDeviceAgentConnection({ transport: 'usb', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' })).toBe(true);
  expect(isDirectUsbDeviceAgentConnection({ transport: 'wifi', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd', usbmuxNetwork: true })).toBe(false);
  expect(isDirectUsbDeviceAgentConnection({ transport: 'wifi', host: 'ipad.local', udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' })).toBe(false);
});

test('uses the Rust bridge for USB and paired Wi-Fi devices after cutover', () => {
  const connection = { transport: 'usb' as const, udid: '2a0e0924d60bbd25e9ce1398fa5543128ec5a5dd' };
  const networkConnection = { transport: 'wifi' as const, udid: connection.udid, usbmuxNetwork: true };
  expect(getDeviceTransportOrder(connection, 'auto')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(connection, 'autoinstall')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(connection, 'ssh')).toEqual(['autoinstall']);
  expect(getDeviceTransportOrder(networkConnection, 'ssh')).toEqual(['autoinstall']);
});

test('backs off USB agent reconnects long enough for USBMux to recover', () => {
  expect([0, 1, 2, 3, 4, 5].map(getDeviceAgentRetryDelay)).toEqual([500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});

test('retries transient Rust device health gaps before reporting USB absence', async () => {
  let attempts = 0;
  await expect(retryRustDeviceHealthProbe(async () => {
    attempts += 1;
    return { state: 'ready', transport: 'usb', deviceCount: attempts === 3 ? 1 : 0, devicePresent: attempts === 3 };
  }, 3, 0)).resolves.toMatchObject({ devicePresent: true, deviceCount: 1 });
  expect(attempts).toBe(3);
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
