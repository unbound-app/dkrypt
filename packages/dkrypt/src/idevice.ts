import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connect as connectSocket, createServer, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client, type Channel } from 'ssh2';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';
import { BRIDGE_PROTOCOL_VERSION } from '#bridgeProtocol.js';
import type { BridgeChannel } from '#bridgeProtocol.js';

const log = scopedLogger('idevice');

const AUTOCONFIRM_FLAG_PATH = '/tmp/autoinstall-autoconfirm.flag';
const BRIDGE_ROOT_PATH = '/tmp/autoinstall/v1';
const BRIDGE_SECRET_FILE_NAME = 'autoinstall-bridge-secret';
const BRIDGE_SECRET_REMOTE_PATH = '/var/mobile/Library/Preferences/dev.adrian.autoinstall-bridge.secret';
const BRIDGE_ARTIFACT_TTL_MINUTES = 30;
const REMOTE_COMMAND_TIMEOUT_MS = 10_000;
const SSH_HANDSHAKE_RETRIES = 1;
const SSH_HANDSHAKE_RETRY_DELAY_MS = 150;
const SSH_SESSION_IDLE_TIMEOUT_MS = 15_000;
const DEVICE_AGENT_CONNECT_RETRIES = 6;
const DEVICE_AGENT_RETRY_DELAY_MS = 500;
const DEVICE_AGENT_IDLE_TIMEOUT_MS = 5 * 60_000;
const DEVICE_AGENT_UNAVAILABLE_TTL_MS = 15_000;
const DEVICE_AGENT_PORT = 5913;
const USBMUX_TUNNEL_READY_TIMEOUT_MS = 8_000;

export type { BridgeChannel } from '#bridgeProtocol.js';

export interface BridgeEnvelope {
  version: number;
  requestId: string;
  issuedAt: number;
  payload: string;
  signature: string;
}

export interface BridgeErrorDetails {
  code?: string;
  stage?: string;
  message: string;
  retryable: boolean;
}

export interface BridgeHeartbeat {
  bridgeVersion?: string;
  channel?: BridgeChannel;
  process?: string;
  at?: number;
}

export class BridgeError extends Error {
  readonly details: BridgeErrorDetails;

  constructor(details: BridgeErrorDetails) {
    super(`${details.code ?? 'bridge_error'} at ${details.stage ?? 'unknown stage'}: ${details.message}`);
    this.name = 'BridgeError';
    this.details = details;
  }
}

interface DeviceAuth {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

interface RawDeviceConfig {
  device?: {
    host?: string;
    port?: number;
    user?: string;
    auth?: { keyPath?: string };
  };
}

const authCache = new Map<string, DeviceAuth>();
const bridgeSecretCache = new Map<string, string>();
const connectionRoots = new WeakMap<Client, string>();

interface SshSession {
  conn: Client;
  rootDir: string;
  tunnel?: { process: ChildProcess };
  idleTimer?: NodeJS.Timeout;
  unusable: boolean;
}

export interface DeviceSession {
  readonly transport: 'ssh' | 'autoinstall';
  readonly rootDir: string;
  exec(command: string, timeoutMs?: number): Promise<{ stdout: string; stderr: string; code: number | null }>;
  close(): void;
}

export type DeviceClient = Client | DeviceSession;

interface DeviceAgentEnvelope {
  version: number;
  requestId: string;
  issuedAt: number;
  payload: string;
  signature: string;
}

interface DeviceAgentPendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function encodeDeviceAgentFrame(value: object): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length === 0 || body.length > 4 * 1024 * 1024) throw new Error('autoinstall device agent request is too large');
  const frame = Buffer.allocUnsafe(body.length + 4);
  frame.writeUInt32BE(body.length, 0);
  body.copy(frame, 4);
  return frame;
}

class DeviceAgentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeviceAgentUnavailableError';
  }
}

class DeviceAgentRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceAgentRequestError';
  }
}

class AutoinstallDeviceClient implements DeviceSession {
  readonly transport = 'autoinstall' as const;
  readonly rootDir: string;
  private readonly socket: Socket;
  private readonly secret: string;
  private readonly pending = new Map<string, DeviceAgentPendingRequest>();
  private input = Buffer.alloc(0);
  private unusable = false;

  constructor(socket: Socket, secret: string, rootDir: string) {
    this.socket = socket;
    this.secret = secret;
    this.rootDir = rootDir;
    socket.setKeepAlive(true, 20_000);
    socket.on('data', (chunk) => this.receive(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('autoinstall device agent connection closed')));
  }

  get isUnusable(): boolean {
    return this.unusable;
  }

  async call(action: string, payload: Record<string, unknown>, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
    if (this.unusable) throw new Error('autoinstall device agent connection is closed');
    const requestId = randomUUID();
    const envelope = createDeviceAgentEnvelope(this.secret, requestId, { action, ...payload });
    const frame = encodeDeviceAgentFrame(envelope);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.unusable = true;
        reject(new Error(`autoinstall device agent request timed out: ${action}`));
        this.socket.destroy();
      }, Math.max(1, timeoutMs));
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.write(frame, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(requestId);
        this.unusable = true;
        reject(error);
        this.socket.destroy();
      });
    });
  }

  async exec(command: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const result = await this.call('exec', { command, timeoutMs }, timeoutMs + 1_000);
    return {
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      code: typeof result.code === 'number' ? result.code : null,
    };
  }

  close(): void {
    if (this.unusable) {
      this.socket.destroy();
      return;
    }
    this.unusable = true;
    this.fail(new Error('autoinstall device agent connection closed'));
    this.socket.destroy();
  }

  private receive(chunk: Buffer): void {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 4) {
      const length = this.input.readUInt32BE(0);
      if (length <= 0 || length > 4 * 1024 * 1024) {
        this.fail(new Error(`autoinstall device agent returned an invalid frame length: ${length}`));
        return;
      }
      if (this.input.length < length + 4) return;
      const body = this.input.subarray(4, length + 4);
      this.input = this.input.subarray(length + 4);
      let envelope: DeviceAgentEnvelope;
      try {
        envelope = JSON.parse(body.toString('utf8')) as DeviceAgentEnvelope;
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const pending = this.pending.get(envelope.requestId);
      if (!pending) continue;
      this.pending.delete(envelope.requestId);
      clearTimeout(pending.timer);
      try {
        pending.resolve(parseDeviceAgentResponse(this.secret, envelope));
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        pending.reject(normalized);
        if (!(normalized instanceof DeviceAgentRequestError)) {
          this.unusable = true;
          this.socket.destroy();
        }
      }
    }
  }

  private fail(error: Error): void {
    if (this.unusable && this.pending.size === 0) return;
    this.unusable = true;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(requestId);
    }
  }
}

const sshSessions = new Map<string, SshSession>();
interface DeviceAgentSession {
  client: AutoinstallDeviceClient;
  tunnel?: { process: ChildProcess };
  idleTimer?: NodeJS.Timeout;
}

const deviceAgentSessions = new Map<string, DeviceAgentSession>();
const deviceAgentUnavailableUntil = new Map<string, number>();

export type DeviceTransport = 'wifi' | 'usb';

export interface DeviceConnection {
  id?: string;
  transport?: DeviceTransport;
  host?: string;
  port?: number;
  user?: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  keyPath?: string;
  rootDir?: string;
}

export interface DeviceDiscoveryCandidate {
  discoveryId: string;
  name: string;
  transport: DeviceTransport;
  host?: string;
  port: number;
  user: string;
  udid?: string;
  usbmuxNetwork?: boolean;
  productType?: string;
  productVersion?: string;
  source: 'usb' | 'wifi';
}

export interface DeviceDiscoveryResult {
  devices: DeviceDiscoveryCandidate[];
  scannedNetworks: string[];
  warnings: string[];
}

export interface DeviceSetupInfo {
  name: string;
  model?: string;
  productType?: string;
  productVersion?: string;
  architecture?: string;
  serialNumber?: string;
}

export interface DeviceSetupStep {
  id: string;
  label: string;
  status: 'ready' | 'attention' | 'unavailable';
  detail?: string;
}

export interface DeviceSetupResult {
  info: DeviceSetupInfo;
  steps: DeviceSetupStep[];
  ready: boolean;
}

async function loadDeviceAuth(rootDir: string): Promise<DeviceAuth> {
  const cached = authCache.get(rootDir);
  if (cached) return cached;
  const configPath = path.join(rootDir, 'config.json');
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as RawDeviceConfig;
  const device = raw.device;
  if (!device?.host || !device.port || !device.user || !device.auth?.keyPath) {
    throw new Error(`device connection config at ${configPath} is missing connection info (host/port/user/auth.keyPath)`);
  }
  const auth: DeviceAuth = { host: device.host, port: device.port, user: device.user, keyPath: device.auth.keyPath };
  authCache.set(rootDir, auth);
  return auth;
}

export async function validateDeviceRootDir(rootDir: string): Promise<void> {
  authCache.delete(rootDir);
  await loadDeviceAuth(rootDir);
}

function connectionIdentity(connection: DeviceConnection): string {
  return connection.id ?? connection.udid ?? `${connection.host ?? 'device'}:${connection.port ?? config.deviceSshPort}`;
}

function connectionRuntimeRoot(connection: DeviceConnection): string {
  const transport = connection.transport ?? (connection.udid ? connection.usbmuxNetwork ? 'wifi' : 'usb' : 'wifi');
  const identity = `${transport}:${connectionIdentity(connection)}`;
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  return path.join(config.deviceRuntimeDir, digest);
}

function directDeviceAuth(connection: DeviceConnection): DeviceAuth {
  const usesUsbmux = !connection.host && Boolean(connection.udid);
  if (!usesUsbmux && !connection.host) throw new Error('device host is required');
  return {
    host: connection.host ?? '127.0.0.1',
    port: connection.port ?? config.deviceSshPort,
    user: connection.user ?? config.deviceSshUser,
    keyPath: connection.keyPath ?? config.deviceSshKeyPath,
  };
}

async function resolveDeviceAuth(connection: DeviceConnection | string): Promise<{ auth: DeviceAuth; rootDir: string; usesUsbmux: boolean; networkUsbmux: boolean }> {
  if (typeof connection === 'string') {
    return { auth: await loadDeviceAuth(connection), rootDir: connection, usesUsbmux: false, networkUsbmux: false };
  }
  if (!connection.host && !connection.udid && connection.rootDir) {
    return { auth: await loadDeviceAuth(connection.rootDir), rootDir: connection.rootDir, usesUsbmux: false, networkUsbmux: false };
  }
  return {
    auth: directDeviceAuth(connection),
    rootDir: connectionRuntimeRoot(connection),
    usesUsbmux: !connection.host && Boolean(connection.udid),
    networkUsbmux: connection.usbmuxNetwork === true,
  };
}

async function findFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  if (!address || typeof address === 'string') throw new Error('could not allocate a local device tunnel port');
  return address.port;
}

function canConnectToPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: '127.0.0.1', port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

async function startUsbmuxTunnel(udid: string, remotePort: number, network: boolean): Promise<{ host: string; port: number; process: ChildProcess }> {
  const localPort = await findFreePort();
  const args = [...(network ? ['-n'] : []), '-u', udid, '-s', '127.0.0.1', `${localPort}:${remotePort}`];
  const process = spawn(config.ideviceProxyBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnError = '';
  process.once('error', (error) => {
    spawnError = error.message;
  });
  process.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  for (let attempt = 0; attempt < USBMUX_TUNNEL_READY_TIMEOUT_MS / 100; attempt += 1) {
    if (spawnError) break;
    if (process.exitCode !== null) break;
    if (await canConnectToPort(localPort)) return { host: '127.0.0.1', port: localPort, process };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill();
  const reason = spawnError || stderr.trim();
  throw new Error(`could not open the ${network ? 'Wi-Fi' : 'USB'} device tunnel${reason ? `: ${reason}` : ''}`);
}

function connectDeviceAgentSocket(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = connectSocket({ host, port });
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.once('error', fail);
    socket.setTimeout(5_000, () => fail(new Error('autoinstall device agent connection timed out')));
  });
}

function writeDeviceAgentFrame(socket: Socket, value: Record<string, unknown>): Promise<void> {
  const frame = encodeDeviceAgentFrame(value);
  return new Promise((resolve, reject) => {
    socket.write(frame, (error) => (error ? reject(error) : resolve()));
  });
}

function readDeviceAgentFrame(socket: Socket, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let input = Buffer.alloc(0);
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      socket.off('data', receive);
      socket.off('error', fail);
      socket.off('close', closed);
      socket.setTimeout(0);
      if (error) reject(error);
      else resolve(value as Record<string, unknown>);
    };
    const fail = (error: Error) => finish(error);
    const closed = () => finish(new Error('autoinstall device agent bootstrap connection closed'));
    const receive = (chunk: Buffer) => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4) return;
      const length = input.readUInt32BE(0);
      if (length <= 0 || length > 4 * 1024 * 1024) {
        finish(new Error(`autoinstall device agent returned an invalid frame length: ${length}`));
        return;
      }
      if (input.length < length + 4) return;
      try {
        const value = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as Record<string, unknown>;
        finish(undefined, value);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.on('data', receive);
    socket.once('error', fail);
    socket.once('close', closed);
    socket.setTimeout(timeoutMs, () => finish(new Error('autoinstall device agent bootstrap timed out')));
  });
}

async function bootstrapDeviceAgent(host: string, port: number, secret: string): Promise<void> {
  const socket = await connectDeviceAgentSocket(host, port);
  try {
    const requestId = randomUUID();
    await writeDeviceAgentFrame(socket, { version: 1, requestId, action: 'bootstrap', secret });
    const response = await readDeviceAgentFrame(socket, 5_000);
    if (response.version !== 1 || response.requestId !== requestId || response.ok !== true) {
      throw new Error('autoinstall device agent bootstrap was rejected');
    }
  } finally {
    socket.destroy();
  }
}

async function openDeviceAgentSession(connection: DeviceConnection, key: string): Promise<DeviceAgentSession> {
  if (!connection.udid || connection.host) throw new Error('the autoinstall device agent requires a paired USB device');
  const tunnel = await startUsbmuxTunnel(connection.udid, DEVICE_AGENT_PORT, false);
  try {
    const rootDir = connectionRuntimeRoot(connection);
    const secret = await loadBridgeSecret(rootDir);
    await bootstrapDeviceAgent(tunnel.host, tunnel.port, secret);
    const client = new AutoinstallDeviceClient(await connectDeviceAgentSocket(tunnel.host, tunnel.port), secret, rootDir);
    await client.call('status', {}, 3_000);
    const session: DeviceAgentSession = { client, tunnel };
    deviceAgentSessions.set(key, session);
    deviceAgentUnavailableUntil.delete(key);
    log.info('connected to the dkrypt device agent over USBMux', { deviceId: key });
    return session;
  } catch (error) {
    tunnel.process.kill();
    throw error;
  }
}

function closeDeviceAgentSession(key: string, session: DeviceAgentSession): void {
  if (deviceAgentSessions.get(key) === session) deviceAgentSessions.delete(key);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.client.close();
  session.tunnel?.process.kill();
}

async function getDeviceAgentSession(connection: DeviceConnection): Promise<{ key: string; session: DeviceAgentSession }> {
  const key = sshSessionKey(connection);
  const existing = deviceAgentSessions.get(key);
  if (existing && !existing.client.isUnusable) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return { key, session: existing };
  }
  if (existing) closeDeviceAgentSession(key, existing);
  let lastError: unknown;
  for (let attempt = 0; attempt < DEVICE_AGENT_CONNECT_RETRIES; attempt += 1) {
    try {
      return { key, session: await openDeviceAgentSession(connection, key) };
    } catch (error) {
      lastError = error;
      if (attempt + 1 < DEVICE_AGENT_CONNECT_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, getDeviceAgentRetryDelay(attempt)));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getDeviceAgentRetryDelay(attempt: number): number {
  return Math.min(DEVICE_AGENT_RETRY_DELAY_MS * 2 ** Math.max(0, attempt), 5_000);
}

function releaseDeviceAgentSession(key: string, session: DeviceAgentSession): void {
  if (deviceAgentSessions.get(key) !== session || session.client.isUnusable) {
    closeDeviceAgentSession(key, session);
    return;
  }
  session.idleTimer = setTimeout(() => {
    if (deviceAgentSessions.get(key) === session) closeDeviceAgentSession(key, session);
  }, DEVICE_AGENT_IDLE_TIMEOUT_MS);
  session.idleTimer.unref();
}

async function ensureIpadecryptRuntime(rootDir: string, auth: DeviceAuth): Promise<string> {
  await mkdir(rootDir, { recursive: true });
  const configPath = path.join(rootDir, 'config.json');
  await writeFile(configPath, buildIpadecryptRuntimeConfig(auth), { mode: 0o600 });
  await chmod(configPath, 0o600);
  return rootDir;
}

export function buildIpadecryptRuntimeConfig(auth: { host: string; port: number; user: string; keyPath: string }): string {
  return `${JSON.stringify({
    version: 2,
    apple: { email: 'managed-device@dkrypt.invalid' },
    device: { host: auth.host, port: auth.port, user: auth.user, auth: { kind: 'key', keyPath: auth.keyPath } },
  })}\n`;
}

async function withDeviceTunnel<T>(connection: DeviceConnection | string, fn: (auth: DeviceAuth, rootDir: string) => Promise<T>): Promise<T> {
  const resolved = await resolveDeviceAuth(connection);
  if (!resolved.usesUsbmux) return fn(resolved.auth, resolved.rootDir);
  if (typeof connection === 'string' || !connection.udid) throw new Error('a paired device identifier is required for USB setup');
  const tunnel = await startUsbmuxTunnel(connection.udid, resolved.auth.port, resolved.networkUsbmux);
  try {
    return await fn({ ...resolved.auth, host: tunnel.host, port: tunnel.port }, resolved.rootDir);
  } finally {
    tunnel.process.kill();
  }
}

function makeSerialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = queue.then(fn, fn);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

const withSSHLock = makeSerialQueue();

function sshSessionKey(connection: DeviceConnection | string): string {
  if (typeof connection === 'string') return 'root:' + connection;
  if (connection.id) return 'id:' + connection.id;
  if (connection.udid) return 'udid:' + connection.udid;
  return 'host:' + (connection.host ?? 'device') + ':' + (connection.port ?? config.deviceSshPort);
}

function isTransientSshConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out while waiting for handshake|connection lost before handshake|connection reset by peer|socket hang up|ECONNRESET/i.test(message);
}

export async function retryTransientSshConnection<T>(operation: () => Promise<T>, maxRetries = SSH_HANDSHAKE_RETRIES, delayMs = SSH_HANDSHAKE_RETRY_DELAY_MS): Promise<T> {
  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientSshConnectionError(error) || retries >= maxRetries) throw error;
      retries += 1;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function connectSshClient(auth: DeviceAuth, privateKey: Buffer): Promise<Client> {
  const conn = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      reject(error);
    };
    conn.on('error', fail);
    conn.once('ready', () => {
      settled = true;
      resolve(conn);
    });
    try {
      conn.connect({ host: auth.host, port: auth.port, username: auth.user, privateKey, readyTimeout: 15_000 });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function closeSshSession(key: string, session: SshSession): void {
  if (sshSessions.get(key) === session) sshSessions.delete(key);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.unusable = true;
  connectionRoots.delete(session.conn);
  session.conn.end();
  session.tunnel?.process.kill();
}

async function openSshSession(connection: DeviceConnection | string, key: string): Promise<SshSession> {
  const resolved = await resolveDeviceAuth(connection);
  let privateKey: Buffer;
  try {
    privateKey = await readFile(resolved.auth.keyPath);
  } catch (err) {
    invalidateAuthCache(connection);
    throw err;
  }
  let tunnel: { host: string; port: number; process: ChildProcess } | undefined;
  try {
    if (resolved.usesUsbmux) {
      if (typeof connection === 'string' || !connection.udid) throw new Error('a paired device identifier is required for USB setup');
      tunnel = await startUsbmuxTunnel(connection.udid, resolved.auth.port, resolved.networkUsbmux);
    }
    const auth = tunnel ? { ...resolved.auth, host: tunnel.host, port: tunnel.port } : resolved.auth;
    const conn = await retryTransientSshConnection(() => connectSshClient(auth, privateKey));
    const session: SshSession = { conn, rootDir: resolved.rootDir, tunnel, unusable: false };
    conn.on('error', () => {
      session.unusable = true;
    });
    conn.once('end', () => {
      session.unusable = true;
    });
    conn.once('close', () => {
      session.unusable = true;
    });
    connectionRoots.set(conn, resolved.rootDir);
    sshSessions.set(key, session);
    return session;
  } catch (err) {
    tunnel?.process.kill();
    throw err;
  }
}

async function getSshSession(connection: DeviceConnection | string): Promise<{ key: string; session: SshSession }> {
  const key = sshSessionKey(connection);
  const existing = sshSessions.get(key);
  if (existing && !existing.unusable) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return { key, session: existing };
  }
  if (existing) closeSshSession(key, existing);
  return { key, session: await openSshSession(connection, key) };
}

function releaseSshSession(key: string, session: SshSession): void {
  if (sshSessions.get(key) !== session) {
    closeSshSession(key, session);
    return;
  }
  if (session.unusable) {
    closeSshSession(key, session);
    return;
  }
  session.idleTimer = setTimeout(() => {
    if (sshSessions.get(key) === session) closeSshSession(key, session);
  }, SSH_SESSION_IDLE_TIMEOUT_MS);
  session.idleTimer.unref();
}

function invalidateAuthCache(connection: DeviceConnection | string): void {
  if (typeof connection === 'string') {
    authCache.delete(connection);
  } else if (connection.rootDir) {
    authCache.delete(connection.rootDir);
  }
}

function shouldAttemptDeviceAgent(connection: DeviceConnection | string): boolean {
  if (!isDirectUsbDeviceAgentConnection(connection)) return false;
  const mode = config.deviceTransport.toLowerCase();
  if (mode === 'ssh') return false;
  const key = sshSessionKey(connection);
  if (mode === 'autoinstall') return true;
  return (deviceAgentUnavailableUntil.get(key) ?? 0) <= Date.now();
}

export function isDirectUsbDeviceAgentConnection(connection: DeviceConnection | string): connection is DeviceConnection {
  return typeof connection !== 'string' && Boolean(connection.udid && !connection.host && connection.usbmuxNetwork !== true);
}

export function getDeviceTransportOrder(connection: DeviceConnection | string, mode = config.deviceTransport): Array<'autoinstall' | 'ssh'> {
  const normalizedMode = mode.toLowerCase();
  if (normalizedMode === 'ssh') return ['ssh'];
  if (typeof connection === 'string' || !isDirectUsbDeviceAgentConnection(connection)) return ['ssh'];
  return normalizedMode === 'autoinstall' ? ['autoinstall'] : ['autoinstall', 'ssh'];
}

async function withDeviceAgent<T>(connection: DeviceConnection, fn: (client: DeviceClient) => Promise<T>): Promise<T> {
  return withSSHLock(async () => {
    let opened: { key: string; session: DeviceAgentSession };
    try {
      opened = await getDeviceAgentSession(connection);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeviceAgentUnavailableError(`could not connect to the dkrypt device agent: ${detail}`, { cause: error });
    }
    try {
      return await fn(opened.session.client);
    } catch (error) {
      if (opened.session.client.isUnusable) {
        throw new DeviceAgentUnavailableError('the dkrypt device agent connection was lost', { cause: error });
      }
      throw error;
    } finally {
      releaseDeviceAgentSession(opened.key, opened.session);
    }
  });
}

export async function withAutoinstallDeviceAgent<T>(connection: DeviceConnection, fn: (client: DeviceClient) => Promise<T>): Promise<T> {
  if (!isDirectUsbDeviceAgentConnection(connection)) throw new DeviceAgentUnavailableError('the direct USB recovery channel is unavailable for this device');
  return withDeviceAgent(connection, fn);
}

export async function withSSH<T>(connection: DeviceConnection | string, fn: (conn: DeviceClient) => Promise<T>): Promise<T> {
  const transportOrder = getDeviceTransportOrder(connection);
  if (transportOrder[0] === 'autoinstall' && shouldAttemptDeviceAgent(connection)) {
    try {
      return await withDeviceAgent(connection as DeviceConnection, fn);
    } catch (error) {
      const key = sshSessionKey(connection);
      if (!(error instanceof DeviceAgentUnavailableError) || transportOrder.length === 1) throw error;
      deviceAgentUnavailableUntil.set(key, Date.now() + DEVICE_AGENT_UNAVAILABLE_TTL_MS);
      log.warn('autoinstall device agent unavailable; falling back to SSH', { deviceId: key, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return withSSHLock(async () => {
    let key = '';
    let session: SshSession | undefined;
    try {
      const opened = await getSshSession(connection);
      key = opened.key;
      session = opened.session;
      return await fn(session.conn);
    } catch (err) {
      invalidateAuthCache(connection);
      if (session && (session.unusable || isTransientSshConnectionError(err))) closeSshSession(key, session);
      throw err;
    } finally {
      if (session) releaseSshSession(key, session);
    }
  });
}

export async function withIpadecrypt<T>(connection: DeviceConnection | string, fn: (rootDir: string) => Promise<T>): Promise<T> {
  return withDeviceTunnel(connection, async (auth, rootDir) => fn(typeof connection === 'string' ? rootDir : await ensureIpadecryptRuntime(rootDir, auth)));
}

interface LocalCommandResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runLocalCommand(file: string, args: string[], timeoutMs: number): Promise<LocalCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        resolve({ stdout, stderr: `${stderr}\ncommand timed out`.trim(), code: null });
      }
    }, timeoutMs);
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    };
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      stderr = `${stderr}\n${error.message}`.trim();
      finish(null);
    });
    child.on('close', finish);
  });
}

function parseKeyValueOutput(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return values;
}

function parseIdeviceInfo(output: string): Record<string, string> {
  return parseKeyValueOutput(output);
}

async function listUsbmuxDevices(network: boolean): Promise<{ ids: string[]; available: boolean; error?: string }> {
  const result = await runLocalCommand(config.ideviceIdBin, network ? ['-n'] : ['-l'], 5_000);
  if (result.code === null || result.code !== 0) {
    return { ids: [], available: false, error: result.stderr.trim() || `${config.ideviceIdBin} exited with code ${result.code ?? 'unknown'}` };
  }
  return { ids: result.stdout.split('\n').map((id) => id.trim()).filter(Boolean), available: true };
}

async function getUsbmuxInfo(udid: string, network: boolean): Promise<Record<string, string>> {
  const result = await runLocalCommand(config.ideviceInfoBin, [...(network ? ['-n'] : []), '-u', udid], 5_000);
  return result.code === 0 ? parseIdeviceInfo(result.stdout) : {};
}

function candidateFromUsbmux(udid: string, info: Record<string, string>, network: boolean): DeviceDiscoveryCandidate {
  const productType = info.ProductType;
  const productVersion = info.ProductVersion;
  const name = info.DeviceName || productType || `${network ? 'Wi-Fi' : 'USB'} iDevice`;
  return {
    discoveryId: `${network ? 'wifi' : 'usb'}-${udid}`,
    name,
    transport: network ? 'wifi' : 'usb',
    port: config.deviceSshPort,
    user: config.deviceSshUser,
    udid,
    usbmuxNetwork: network,
    productType,
    productVersion,
    source: network ? 'wifi' : 'usb',
  };
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function ipv4ToNumber(host: string): number | undefined {
  if (!isPrivateIpv4(host)) return undefined;
  return host.split('.').map(Number).reduce((value, octet) => (value << 8) + octet, 0) >>> 0;
}

function numberToIpv4(value: number): string {
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function parseDiscoverySubnet(value: string): string | undefined {
  const [rawHost, rawPrefix] = value.trim().split('/');
  const host = ipv4ToNumber(rawHost);
  const prefix = Number(rawPrefix ?? '24');
  if (host === undefined || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) return undefined;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = host & mask;
  const scanPrefix = Math.max(prefix, 24);
  const scanMask = (0xffffffff << (32 - scanPrefix)) >>> 0;
  return `${numberToIpv4(network & scanMask)}/${scanPrefix}`;
}

function localDiscoverySubnets(): string[] {
  const values = new Set<string>();
  const configured = config.deviceDiscoverySubnets.split(',').map(parseDiscoverySubnet).filter((value): value is string => Boolean(value));
  for (const value of configured) values.add(value);
  if (values.size > 0) return [...values];
  for (const interfaces of Object.values(os.networkInterfaces())) {
    for (const address of interfaces ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      const subnet = parseDiscoverySubnet(`${address.address}/${address.cidr?.split('/')[1] ?? '24'}`);
      if (subnet) values.add(subnet);
    }
  }
  return [...values];
}

function hostsInSubnet(subnet: string): string[] {
  const [rawNetwork, rawPrefix] = subnet.split('/');
  const network = ipv4ToNumber(rawNetwork);
  const prefix = Number(rawPrefix);
  if (network === undefined || !Number.isInteger(prefix) || prefix < 16 || prefix > 30) return [];
  const size = 2 ** (32 - prefix);
  const first = network + 1;
  const last = network + size - 2;
  const hosts: string[] = [];
  for (let value = first; value <= last; value += 1) hosts.push(numberToIpv4(value >>> 0));
  return hosts;
}

function canConnectToHost(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connectSocket({ host, port });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

async function probeWifiHost(host: string, privateKey: Buffer): Promise<DeviceDiscoveryCandidate | undefined> {
  if (!(await canConnectToHost(host, config.deviceSshPort, 350))) return undefined;
  const conn = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => resolve());
      conn.on('error', reject);
      conn.connect({ host, port: config.deviceSshPort, username: config.deviceSshUser, privateKey, readyTimeout: 1_500 });
    });
    const system = await readRemoteValue(conn, 'uname -s 2>/dev/null');
    if (system !== 'Darwin') return undefined;
    const model = await readRemoteValue(conn, 'sysctl -n hw.machine 2>/dev/null') ?? await readRemoteValue(conn, 'uname -m 2>/dev/null');
    const productVersion = await readRemoteValue(conn, '/var/jb/usr/bin/sw_vers -productVersion 2>/dev/null');
    const name = await readRemoteValue(conn, 'scutil --get ComputerName 2>/dev/null') ?? await readRemoteValue(conn, 'hostname 2>/dev/null');
    return {
      discoveryId: `wifi-${host}`,
      name: name || model || host,
      transport: 'wifi',
      host,
      port: config.deviceSshPort,
      user: config.deviceSshUser,
      productType: model,
      productVersion,
      source: 'wifi',
    };
  } catch {
    return undefined;
  } finally {
    conn.end();
  }
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, fn: (value: T) => Promise<R | undefined>): Promise<R[]> {
  const result: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = await fn(values[index]);
      if (value !== undefined) result.push(value);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return result;
}

export async function discoverDevices(): Promise<DeviceDiscoveryResult> {
  const devices: DeviceDiscoveryCandidate[] = [];
  const warnings: string[] = [];
  const usb = await listUsbmuxDevices(false);
  if (!usb.available && usb.error) warnings.push(`USB discovery unavailable: ${usb.error}`);
  for (const udid of usb.ids) devices.push(candidateFromUsbmux(udid, await getUsbmuxInfo(udid, false), false));

  const network = await listUsbmuxDevices(true);
  if (!network.available && network.error && usb.available) warnings.push(`paired Wi-Fi discovery unavailable: ${network.error}`);
  for (const udid of network.ids) devices.push(candidateFromUsbmux(udid, await getUsbmuxInfo(udid, true), true));

  let privateKey: Buffer | undefined;
  try {
    privateKey = await readFile(config.deviceSshKeyPath);
  } catch {
    warnings.push(`Wi-Fi SSH discovery needs a readable key at ${config.deviceSshKeyPath}`);
  }
  const explicitHosts = config.deviceDiscoveryHosts
    .split(',')
    .map((host) => host.trim())
    .filter((host) => isPrivateIpv4(host));
  const scannedNetworks = localDiscoverySubnets();
  const scanHosts = [...new Set([...explicitHosts, ...scannedNetworks.flatMap(hostsInSubnet)])];
  if (privateKey && scanHosts.length > 0) {
    devices.push(...(await mapWithConcurrency(scanHosts, 24, (host) => probeWifiHost(host, privateKey as Buffer))));
  }

  const unique = new Map<string, DeviceDiscoveryCandidate>();
  for (const device of devices) unique.set(device.discoveryId, device);
  return { devices: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name)), scannedNetworks, warnings };
}

async function queryPackageVersion(conn: DeviceClient, packageName: string): Promise<string | undefined> {
  const result = await execCommand(conn, `/var/jb/usr/bin/dpkg-query -W -f='\${Status}|\${Version}' ${packageName} 2>/dev/null`).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  if (result.code !== 0 || !result.stdout.startsWith('install ok installed|')) return undefined;
  return result.stdout.slice('install ok installed|'.length).trim() || 'installed';
}

async function readRemoteValue(conn: DeviceClient, command: string): Promise<string | undefined> {
  const result = await execCommand(conn, command).catch(() => ({ stdout: '', stderr: '', code: 1 }));
  if (result.code !== 0) return undefined;
  const value = result.stdout.trim();
  return value || undefined;
}

export async function setupDeviceConnection(connection: DeviceConnection): Promise<DeviceSetupResult> {
  return withSSH(connection, async (conn) => {
    const system = await readRemoteValue(conn, 'uname -s 2>/dev/null');
    const model = await readRemoteValue(conn, 'sysctl -n hw.machine 2>/dev/null') ?? await readRemoteValue(conn, 'uname -m 2>/dev/null');
    const productVersion = await readRemoteValue(conn, '/var/jb/usr/bin/sw_vers -productVersion 2>/dev/null');
    const architecture = await readRemoteValue(conn, 'uname -p 2>/dev/null') ?? await readRemoteValue(conn, 'uname -m 2>/dev/null');
    const name = await readRemoteValue(conn, 'scutil --get ComputerName 2>/dev/null') ?? await readRemoteValue(conn, 'hostname 2>/dev/null');
    const jailbreak = await execCommand(conn, 'test -d /var/jb').then(({ code }) => code === 0).catch(() => false);
    const ellekitVersion = await queryPackageVersion(conn, 'ellekit');
    const autoinstallVersion = await queryPackageVersion(conn, 'dev.adrian.autoinstall');
    const openSshVersion = await queryPackageVersion(conn, 'openssh-server');
    const bridge = await execCommand(conn, 'test -s /tmp/autoinstall/v1/springboard/state/heartbeat.json').then(({ code }) => code === 0).catch(() => false);
    const systemReady = system === 'Darwin';
    const runtimeTransport = 'transport' in conn ? conn.transport : 'ssh';
    const usbAgentExpected = Boolean(connection.udid && !connection.host && connection.usbmuxNetwork !== true);
    const agentReady = !usbAgentExpected || runtimeTransport === 'autoinstall';
    const transportLabel = usbAgentExpected ? 'dkrypt device agent' : 'SSH connection';
    const transportDetail = runtimeTransport === 'autoinstall'
      ? `Authenticated USBMux device agent${autoinstallVersion ? ` · autoinstall ${autoinstallVersion}` : ''}`
      : usbAgentExpected
        ? 'USB is reachable through SSH fallback; install the current autoinstall package to enable the device agent'
        : `${connection.user ?? config.deviceSshUser}@${connection.host ?? 'USB/Wi-Fi tunnel'}${openSshVersion ? ` · OpenSSH ${openSshVersion}` : ''}`;
    const bridgeReady = bridge;
    const info: DeviceSetupInfo = {
      name: name || model || connection.host || 'iDevice',
      model,
      productType: model,
      productVersion,
      architecture,
    };
    const steps: DeviceSetupStep[] = [
      { id: 'ssh', label: transportLabel, status: agentReady ? 'ready' : 'attention', detail: transportDetail },
      { id: 'ios', label: 'iOS device detected', status: systemReady ? 'ready' : 'attention', detail: systemReady ? `${info.productType ?? 'iDevice'} · iOS ${info.productVersion ?? 'unknown'}` : 'The device connection did not report Darwin.' },
      { id: 'jailbreak', label: 'Rootless jailbreak', status: jailbreak ? 'ready' : 'attention', detail: jailbreak ? `/var/jb is available${ellekitVersion ? ` · ElleKit ${ellekitVersion}` : ''}` : 'Install and enable a rootless jailbreak before continuing.' },
      { id: 'bridge', label: 'autoinstall bridge', status: bridgeReady ? 'ready' : 'attention', detail: bridgeReady ? 'SpringBoard heartbeat is responding' : 'Install autoinstall, then run setup again.' },
    ];
    if (!systemReady) steps[1] = { id: 'ios', label: 'iOS device detected', status: 'unavailable', detail: 'The device connection did not report Darwin.' };
    return { info, steps, ready: steps.every((step) => step.status === 'ready') };
  });
}

async function loadBridgeSecret(rootDir: string): Promise<string> {
  const cached = bridgeSecretCache.get(rootDir);
  if (cached) return cached;
  const secretPath = path.join(rootDir, BRIDGE_SECRET_FILE_NAME);
  try {
    const secret = (await readFile(secretPath, 'utf8')).trim();
    if (secret.length >= 32) {
      bridgeSecretCache.set(rootDir, secret);
      return secret;
    }
  } catch {}
  await mkdir(rootDir, { recursive: true });
  const secret = randomBytes(32).toString('base64url');
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 });
  await chmod(secretPath, 0o600);
  bridgeSecretCache.set(rootDir, secret);
  return secret;
}

function bridgeSignature(secret: string, channel: BridgeChannel, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret)
    .update(`${BRIDGE_PROTOCOL_VERSION}|${channel}|${requestId}|${issuedAt}|${payload}`)
    .digest('hex');
}

function deviceAgentSignature(secret: string, prefix: string, requestId: string, issuedAt: number, payload: string): string {
  return createHmac('sha256', secret).update(`${prefix}|${requestId}|${issuedAt}|${payload}`).digest('hex');
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodeBase64Url(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

export function createDeviceAgentEnvelope(secret: string, requestId: string, request: Record<string, unknown>, issuedAt = Math.floor(Date.now() / 1000)): DeviceAgentEnvelope {
  const payload = encodeBase64Url(JSON.stringify(request));
  return {
    version: 1,
    requestId,
    issuedAt,
    payload,
    signature: deviceAgentSignature(secret, 'dkrypt-autoinstall-agent-v1', requestId, issuedAt, payload),
  };
}

function parseDeviceAgentResponse(secret: string, envelope: DeviceAgentEnvelope): Record<string, unknown> {
  if (envelope.version !== 1 || typeof envelope.requestId !== 'string' || typeof envelope.issuedAt !== 'number' || typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    throw new Error('autoinstall device agent returned an invalid response envelope');
  }
  if (Math.abs(Date.now() / 1000 - envelope.issuedAt) > 120) throw new Error('autoinstall device agent response expired');
  const expected = deviceAgentSignature(secret, 'dkrypt-autoinstall-agent-response-v1', envelope.requestId, envelope.issuedAt, envelope.payload);
  if (expected !== envelope.signature) throw new Error('autoinstall device agent response signature did not match');
  const payload = JSON.parse(decodeBase64Url(envelope.payload)) as Record<string, unknown>;
  if (payload.ok !== true) {
    const error = payload.error;
    const details = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
    throw new DeviceAgentRequestError(`${typeof details.code === 'string' ? details.code : 'device_agent_error'}: ${typeof details.message === 'string' ? details.message : 'device agent request failed'}`);
  }
  const result = payload.result;
  return result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
}

export function createBridgeEnvelope(secret: string, channel: BridgeChannel, request: Record<string, unknown>, requestId: string = randomUUID(), issuedAt = Math.floor(Date.now() / 1000)): BridgeEnvelope {
  const payload = Buffer.from(JSON.stringify(request)).toString('base64url');
  return {
    version: BRIDGE_PROTOCOL_VERSION,
    requestId,
    issuedAt,
    payload,
    signature: bridgeSignature(secret, channel, requestId, issuedAt, payload),
  };
}

function isDeviceSession(conn: DeviceClient): conn is DeviceSession {
  return 'transport' in conn && 'rootDir' in conn && typeof conn.exec === 'function';
}

export function execCommand(conn: DeviceClient, command: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (isDeviceSession(conn)) return conn.exec(command, timeoutMs);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stream: Channel | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.destroy();
      reject(error);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream?.destroy();
      resolve({ stdout, stderr: `${stderr}\ncommand timed out after ${effectiveTimeoutMs}ms`.trim(), code: null });
    }, effectiveTimeoutMs);
    try {
      conn.exec(command, (err, nextStream) => {
        if (settled) {
          nextStream?.destroy();
          return;
        }
        if (err) {
          fail(err);
          return;
        }
        stream = nextStream;
        nextStream.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8');
        });
        nextStream.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString('utf8');
        });
        nextStream.on('close', (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ stdout, stderr, code });
        });
        nextStream.on('error', fail);
      });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function writeRemoteFile(conn: DeviceClient, remotePath: string, content: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<void> {
  return execCommand(conn, `printf %s ${shellQuote(content)} > ${shellQuote(remotePath)}`, timeoutMs).then(({ code, stderr }) => {
    if (code !== 0) throw new Error(`could not write remote file: ${stderr.trim() || `exit code ${code ?? 'unknown'}`}`);
  });
}

async function writeRemoteFileAtomically(conn: DeviceClient, remotePath: string, content: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<void> {
  const tempPath = `${remotePath}.${randomUUID()}.partial`;
  await writeRemoteFile(conn, tempPath, content, timeoutMs);
  const { code, stderr } = await execCommand(conn, `mv ${shellQuote(tempPath)} ${shellQuote(remotePath)}`, timeoutMs);
  if (code !== 0) throw new Error(`could not publish bridge request: ${stderr || code}`);
}

async function readRemoteFileIfExists(conn: DeviceClient, remotePath: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<string | undefined> {
  const quotedPath = shellQuote(remotePath);
  const { stdout, stderr, code } = await execCommand(conn, `if [ -f ${quotedPath} ]; then cat ${quotedPath}; else exit 44; fi`, timeoutMs);
  if (code === 0) return stdout;
  if (code === 44) return undefined;
  throw new Error(`could not read remote file: ${stderr.trim() || stdout.trim() || `exit code ${code ?? 'unknown'}`}`);
}

export async function readBridgeHeartbeats(conn: DeviceClient): Promise<Partial<Record<BridgeChannel, BridgeHeartbeat>>> {
  const channels: BridgeChannel[] = ['springboard', 'testflight', 'appstore'];
  const heartbeats: Partial<Record<BridgeChannel, BridgeHeartbeat>> = {};
  for (const channel of channels) {
    const raw = await readRemoteFileIfExists(conn, `${BRIDGE_ROOT_PATH}/${channel}/state/heartbeat.json`);
    if (!raw) continue;
    try {
      heartbeats[channel] = JSON.parse(raw) as BridgeHeartbeat;
    } catch {
      continue;
    }
  }
  return heartbeats;
}

export async function isTestFlightRunning(conn: DeviceClient): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i '/TestFlight$' | grep -v grep");
  return stdout.trim().length > 0;
}

export async function isAppStoreRunning(conn: DeviceClient): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i 'AppStore.app/AppStore$' | grep -v grep");
  return stdout.trim().length > 0;
}

export function armAppStoreAutoConfirm(conn: DeviceClient, label = 'Install'): Promise<void> {
  return writeRemoteFile(conn, AUTOCONFIRM_FLAG_PATH, label);
}

export async function clearAppStoreAutoConfirm(conn: DeviceClient): Promise<void> {
  await execCommand(conn, `rm -f ${AUTOCONFIRM_FLAG_PATH}`);
}

export async function uninstallInstalledApp(conn: DeviceClient, bundleId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)) return false;

  const { stdout, code } = await execCommand(conn, `uicache -i "${bundleId}" 2>/dev/null`);
  if (code !== 0) return false;

  const foundId = stdout.match(/^Bundle Identifier:\s*(.+)$/m)?.[1]?.trim();
  const appPath = stdout.match(/^Path:\s*(.+)$/m)?.[1]?.trim();
  const removable = /^Removable:\s*true\s*$/m.test(stdout);

  if (foundId !== bundleId || !appPath || !removable) return false;
  return uninstallInstalledBundle(conn, bundleId, appPath);
}

export async function uninstallInstalledBundle(conn: DeviceClient, bundleId: string, appPath: string): Promise<boolean> {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)) return false;
  if (!appPath.endsWith('.app') || !appPath.includes('/var/containers/Bundle/Application/')) return false;

  const container = appPath.replace(/\/[^/]+\.app$/, '');
  if (!/\/var\/containers\/Bundle\/Application\/[^/]+$/.test(container)) return false;

  const { code } = await execCommand(conn, `sudo /var/jb/usr/bin/uicache -u "${appPath}" 2>/dev/null; sudo rm -rf "${container}"`);
  if (code !== 0) return false;
  log.info('uninstalled app from device', { bundleId });
  return true;
}

export async function findInstalledAppStoreBundle(conn: DeviceClient, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `for d in /var/containers/Bundle/Application/*/*.app; do ` +
      `if [ -d "$d/SC_Info" ] && grep -laq "${bundleId}" "$d/Info.plist" 2>/dev/null; then echo "$d"; break; fi; done`,
  );
  const line = stdout.trim().split('\n')[0];
  return line || undefined;
}

export async function listInstalledAppStoreBundles(conn: DeviceClient): Promise<string[]> {
  const { stdout } = await execCommand(conn, 'for d in /var/containers/Bundle/Application/*/*.app; do [ -d "$d/SC_Info" ] && echo "$d"; done');
  return stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).sort();
}

export interface InstalledBundleVersions {
  shortVersion?: string;
  buildVersion?: string;
}

export interface InstallVerification extends InstalledBundleVersions {
  bundleId: string;
  appPath: string;
  fairPlayProtected: true;
  elapsedMs: number;
}

export async function readInstalledBundleVersions(conn: DeviceClient, appPath: string): Promise<InstalledBundleVersions> {
  const tmp = `/tmp/dkrypt-check-${Date.now()}.plist`;
  try {
    await execCommand(conn, `cp "${appPath}/Info.plist" ${tmp} && chmod 644 ${tmp} && /cores/binpack/usr/bin/plutil -convert xml1 ${tmp}`);
    const { stdout } = await execCommand(conn, `cat ${tmp}`);
    const valueFor = (key: string) => stdout.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`))?.[1];
    return { shortVersion: valueFor('CFBundleShortVersionString'), buildVersion: valueFor('CFBundleVersion') };
  } finally {
    await execCommand(conn, `rm -f ${tmp}`).catch(() => {});
  }
}

const withBridgeLock = makeSerialQueue();

async function sendBridgeRequestRawTo(
  conn: DeviceClient,
  channel: BridgeChannel,
  request: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<any> {
  return withBridgeLock(async () => {
    const requestId = typeof request.requestId === 'string' ? request.requestId : randomUUID();
    const rootDir = isDeviceSession(conn) ? conn.rootDir : connectionRoots.get(conn);
    if (!rootDir) throw new Error('autoinstall bridge requests must run through a managed device session');
    const secret = await loadBridgeSecret(rootDir);
    const requestDirectory = `${BRIDGE_ROOT_PATH}/${channel}/requests`;
    const responseDirectory = `${BRIDGE_ROOT_PATH}/${channel}/responses`;
    const requestPath = `${requestDirectory}/${requestId}.json`;
    const responsePath = `${responseDirectory}/${requestId}.response.json`;
    const envelope = createBridgeEnvelope(secret, channel, request, requestId);
    const deadline = Date.now() + timeoutMs;
    const commandTimeout = () => Math.max(1, Math.min(REMOTE_COMMAND_TIMEOUT_MS, deadline - Date.now()));
    log.info('sending authenticated autoinstall bridge request', { requestId, channel, action: request.action });
    const { code, stderr } = await execCommand(
      conn,
      `mkdir -p "${requestDirectory}" "${responseDirectory}" && chmod 700 "${BRIDGE_ROOT_PATH}" "${BRIDGE_ROOT_PATH}/${channel}" "${requestDirectory}" "${responseDirectory}"`,
      commandTimeout(),
    );
    if (code !== 0) throw new Error(`could not prepare autoinstall bridge directories: ${stderr || code}`);
    await writeRemoteFileAtomically(conn, BRIDGE_SECRET_REMOTE_PATH, `${secret}\n`, commandTimeout());
    const secretMode = await execCommand(conn, `chmod 600 "${BRIDGE_SECRET_REMOTE_PATH}"`, commandTimeout());
    if (secretMode.code !== 0) throw new Error(`could not secure autoinstall bridge secret: ${secretMode.stderr || secretMode.code}`);
    await execCommand(conn, `find "${BRIDGE_ROOT_PATH}" -type f -mmin +${BRIDGE_ARTIFACT_TTL_MINUTES} -delete`, commandTimeout());
    await writeRemoteFileAtomically(conn, requestPath, JSON.stringify(envelope), commandTimeout());

    while (Date.now() < deadline) {
      const raw = await readRemoteFileIfExists(conn, responsePath, commandTimeout());
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.requestId === 'string' && parsed.requestId !== requestId) {
          log.warn('discarding autoinstall bridge response with a mismatched request id', { requestId, responseRequestId: parsed.requestId, channel });
          await execCommand(conn, `rm -f ${responsePath}`, commandTimeout());
          continue;
        }
        await execCommand(conn, `rm -f "${responsePath}"`, commandTimeout());
        if (parsed.ok === false) {
          const error = parsed.error;
          if (error && typeof error === 'object') {
            throw new BridgeError({
              code: typeof error.code === 'string' ? error.code : undefined,
              stage: typeof error.stage === 'string' ? error.stage : undefined,
              message: typeof error.message === 'string' ? error.message : JSON.stringify(error),
              retryable: error.retryable === true,
            });
          }
          throw new BridgeError({ message: typeof error === 'string' ? error : String(error), retryable: false });
        }
        return { ...parsed, requestId };
      }
      await new Promise((r) => setTimeout(r, Math.min(500, Math.max(1, deadline - Date.now()))));
    }
    await execCommand(conn, `rm -f "${requestPath}" "${responsePath}"`, commandTimeout()).catch(() => {});
    throw new Error(`autoinstall bridge request timed out (${requestId}) on ${channel}: ${JSON.stringify(request)}`);
  });
}

export function sendTestFlightBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'testflight', request, timeoutMs);
}

export function sendSpringBoardBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'springboard', request, timeoutMs);
}

export function sendAppStoreBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'appstore', request, timeoutMs);
}

export async function tryIoregCandidates(conn: DeviceClient, ioregClass: string, candidates: string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${ioregClass} -w 0 2>&1`);
    if (code === 0 && stdout.includes(ioregClass)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}
