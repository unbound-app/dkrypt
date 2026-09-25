import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { connect as connectSocket, type Socket } from 'node:net';
import path from 'node:path';
import { Client, type Channel } from 'ssh2';
import { config } from '#config.js';
import { scopedLogger } from '#logger.js';
import { BRIDGE_PROTOCOL_VERSION } from '#bridgeProtocol.js';
import type { BridgeChannel } from '#bridgeProtocol.js';
import { startSpan } from '#telemetry.js';
import { incrementMetric, observeMetric } from '#metrics.js';
import { abortedOperationError, delayWithSignal, throwIfAborted } from '#util/abort.js';

const log = scopedLogger('idevice');

const AUTOCONFIRM_FLAG_PATH = '/tmp/autoinstall-autoconfirm.flag';
const AUTOCONFIRM_FLAG_PATHS = [
  AUTOCONFIRM_FLAG_PATH,
  '/private/var/mobile/Library/Caches/com.apple.PassbookUIService/autoinstall-autoconfirm.flag',
  '/private/var/mobile/Library/Caches/com.apple.AuthKitUIService/autoinstall-autoconfirm.flag',
  '/private/var/mobile/Library/Caches/com.apple.ios.StoreKitUIService/autoinstall-autoconfirm.flag',
];
const AUTOCONFIRM_TTL_MS = 6 * 60_000;
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
const USBMUX_TUNNEL_READY_TIMEOUT_MS = 8_000;
const SSH_SFTP_PROBE_TIMEOUT_MS = 5_000;

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

export interface RustDeviceBridgeEvent {
  type: string;
  sequence: number;
  devices: unknown[];
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
  idleTimer?: NodeJS.Timeout;
  unusable: boolean;
}

export interface DeviceSession {
  readonly transport: 'ssh' | 'autoinstall';
  readonly rootDir: string;
  exec(command: string, timeoutMs?: number, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }>;
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

class DeviceAgentUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DeviceAgentUnavailableError';
  }
}

export class DeviceBridgeError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(`${code}: ${message}`);
    this.name = 'DeviceBridgeError';
    this.code = code;
    this.retryable = retryable;
  }
}

interface DeviceAgentClient extends DeviceSession {
  readonly isUnusable: boolean;
  call(action: string, payload: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  cancelPending(): void;
}

interface RustRpcResponse {
  version: number;
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; retryable?: boolean };
}

class RustDeviceBridgeClient {
  private readonly socketPath = config.deviceBridgeSocket;
  private readonly secret = config.deviceBridgeSecret;

  async request(operation: string, details: Record<string, unknown>, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    const startedAt = performance.now();
    const span = startSpan('device.bridge.request', { 'device.operation': operation, 'device.timeout_ms': timeoutMs });
    try {
      throwIfAborted(signal);
      const result = await this.requestRaw(operation, details, timeoutMs, true, signal);
      incrementMetric('device_bridge_requests_total', { operation, outcome: 'success' });
      observeMetric('device_bridge_request_duration_ms', performance.now() - startedAt);
      span.end();
      return result;
    } catch (error) {
      const category = error instanceof DeviceBridgeError ? error.code : error instanceof DeviceAgentUnavailableError ? 'unavailable' : 'unknown';
      incrementMetric('device_bridge_requests_total', { operation, outcome: 'error', category });
      observeMetric('device_bridge_request_duration_ms', performance.now() - startedAt);
      span.end(error);
      throw error;
    }
  }

  private async requestRaw(operation: string, details: Record<string, unknown>, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, cancelOnTimeout = true, signal?: AbortSignal): Promise<unknown> {
    throwIfAborted(signal);
    if (this.secret.length < 32) throw new DeviceAgentUnavailableError('DEVICE_BRIDGE_SECRET is missing or too short');
    const requestId = randomUUID();
    const body = Buffer.from(JSON.stringify({ version: 1, requestId, auth: this.secret, operation, ...details }), 'utf8');
    if (body.length === 0 || body.length > 16 * 1024 * 1024) throw new Error('Rust device bridge request is too large');
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connectSocket({ path: this.socketPath });
      let settled = false;
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        candidate.off('connect', connected);
        candidate.off('error', fail);
        candidate.setTimeout(0);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        candidate.destroy();
        reject(error);
      };
      const connected = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(candidate);
      };
      const onAbort = () => fail(abortedOperationError(signal as AbortSignal));
      candidate.once('connect', connected);
      candidate.once('error', fail);
      candidate.setTimeout(Math.max(1, timeoutMs), () => fail(new Error('Rust device bridge connection timed out')));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    }).catch((error) => {
      throwIfAborted(signal);
      throw new DeviceAgentUnavailableError(`could not connect to the Rust device bridge: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    try {
      return await new Promise<unknown>((resolve, reject) => {
        let input = Buffer.alloc(0);
        let settled = false;
        let onAbort: (() => void) | undefined;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: Error, value?: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (onAbort) signal?.removeEventListener('abort', onAbort);
          socket.off('data', receive);
          socket.off('error', fail);
          socket.off('close', closed);
          socket.setTimeout(0);
          socket.destroy();
          if (error) reject(error);
          else resolve(value);
        };
        const fail = (error: Error) => finish(error);
        const closed = () => finish(new Error('Rust device bridge connection closed'));
        const receive = (chunk: Buffer) => {
          input = Buffer.concat([input, chunk]);
          if (input.length < 4) return;
          const length = input.readUInt32BE(0);
          if (length <= 0 || length > 16 * 1024 * 1024) {
            finish(new Error(`Rust device bridge returned an invalid frame length: ${length}`));
            return;
          }
          if (input.length < length + 4) return;
          let response: RustRpcResponse;
          try {
            response = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as RustRpcResponse;
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          if (response.version !== 1 || response.requestId !== requestId) {
            finish(new Error('Rust device bridge returned a mismatched protocol response'));
            return;
          }
          if (!response.ok) {
            const detail = response.error;
            const code = detail?.code ?? 'device_bridge_error';
            const bridgeError = new DeviceBridgeError(code, detail?.message ?? 'Rust device bridge request failed', detail?.retryable ?? false);
            if (['mux_unavailable', 'device_not_found', 'lockdown_unavailable', 'agent_unavailable', 'agent_timeout', 'tunnel_bind'].includes(code)) {
              finish(new DeviceAgentUnavailableError(bridgeError.message, { cause: bridgeError }));
            } else {
              finish(bridgeError);
            }
            return;
          }
          finish(undefined, response.result);
        };
        const cancelRequest = () => {
          finish(new Error('Rust device bridge request timed out'));
          if (cancelOnTimeout) void this.requestRaw('cancel', { payload: requestId }, 5_000, false).catch(() => undefined);
        };
        const timeoutRequest = () => cancelRequest();
        onAbort = () => {
          finish(abortedOperationError(signal as AbortSignal));
          if (cancelOnTimeout) void this.requestRaw('cancel', { payload: requestId }, 5_000, false).catch(() => undefined);
        };
        timer = setTimeout(timeoutRequest, Math.max(1, timeoutMs));
        socket.on('data', receive);
        socket.once('error', fail);
        socket.once('close', closed);
        socket.setTimeout(Math.max(1, timeoutMs), timeoutRequest);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
        socket.write(frame, (error) => {
          if (error) finish(error);
        });
      });
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof DeviceAgentUnavailableError) throw error;
      throw new DeviceAgentUnavailableError(`Rust device bridge request failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async openTunnel(deviceId: string, port: number, timeoutMs = USBMUX_TUNNEL_READY_TIMEOUT_MS, signal?: AbortSignal): Promise<{ tunnelId: string; host: string; port: number }> {
    const result = await this.request('open_tunnel', { deviceId, port }, timeoutMs, signal);
    if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned an invalid tunnel');
    const tunnel = result as Record<string, unknown>;
    if (typeof tunnel.tunnelId !== 'string' || typeof tunnel.host !== 'string' || typeof tunnel.port !== 'number') throw new Error('Rust device bridge returned an incomplete tunnel');
    return { tunnelId: tunnel.tunnelId, host: tunnel.host, port: tunnel.port };
  }

  async closeTunnel(tunnelId: string): Promise<void> {
    await this.request('close_tunnel', { payload: tunnelId }, 5_000);
  }

  async cancel(requestId: string): Promise<boolean> {
    const result = await this.request('cancel', { payload: requestId }, 5_000);
    return Boolean(result && typeof result === 'object' && (result as Record<string, unknown>).cancelled === true);
  }

  async pair(deviceId: string, hostId?: string): Promise<{ deviceId: string; hostId: string; paired: boolean }> {
    const result = await this.request('pair', { deviceId, ...(hostId ? { hostId } : {}) }, 30_000);
    if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned an invalid pairing response');
    const value = result as Record<string, unknown>;
    if (typeof value.deviceId !== 'string' || typeof value.hostId !== 'string' || value.paired !== true) throw new Error('Rust device bridge returned an incomplete pairing response');
    return { deviceId: value.deviceId, hostId: value.hostId, paired: true };
  }

  async capabilities(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = await this.request('capabilities', {}, 5_000, signal);
    if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned invalid capabilities');
    return result as Record<string, unknown>;
  }

  async health(deviceId?: string): Promise<{ state: string; transport: string; deviceCount: number; devicePresent: boolean }> {
    const result = await this.request('health', deviceId ? { deviceId } : {}, 5_000);
    if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned invalid health');
    const value = result as Record<string, unknown>;
    if (typeof value.state !== 'string' || typeof value.transport !== 'string' || typeof value.deviceCount !== 'number' || typeof value.devicePresent !== 'boolean') throw new Error('Rust device bridge returned incomplete health');
    return { state: value.state, transport: value.transport, deviceCount: value.deviceCount, devicePresent: value.devicePresent };
  }

  async events(): Promise<Record<string, unknown>> {
    const result = await this.request('events', {}, 5_000);
    if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned invalid device events');
    return result as Record<string, unknown>;
  }

  async subscribeEvents(onEvent: (event: RustDeviceBridgeEvent) => void, onError?: (error: Error) => void, signal?: AbortSignal): Promise<() => void> {
    if (this.secret.length < 32) throw new DeviceAgentUnavailableError('DEVICE_BRIDGE_SECRET is missing or too short');
    const requestId = randomUUID();
    const body = Buffer.from(JSON.stringify({ version: 1, requestId, auth: this.secret, operation: 'events', follow: true }), 'utf8');
    const frame = Buffer.allocUnsafe(body.length + 4);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connectSocket({ path: this.socketPath });
      const fail = (error: Error) => {
        candidate.destroy();
        reject(error);
      };
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', fail);
      candidate.setTimeout(5_000, () => fail(new Error('Rust device bridge event connection timed out')));
    }).catch((error) => {
      throw new DeviceAgentUnavailableError(`could not connect to the Rust device bridge: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    });
    return await new Promise<() => void>((resolve, reject) => {
      let input = Buffer.alloc(0);
      let opened = false;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener('abort', stop);
        socket.destroy();
      };
      const fail = (error: Error) => {
        if (!opened) reject(error);
        else onError?.(error);
        stop();
      };
      const receive = (chunk: Buffer) => {
        input = Buffer.concat([input, chunk]);
        while (input.length >= 4) {
          const length = input.readUInt32BE(0);
          if (length <= 0 || length > 16 * 1024 * 1024) {
            fail(new Error(`Rust device bridge returned an invalid event frame length: ${length}`));
            return;
          }
          if (input.length < length + 4) return;
          let response: RustRpcResponse;
          try {
            response = JSON.parse(input.subarray(4, length + 4).toString('utf8')) as RustRpcResponse;
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          input = input.subarray(length + 4);
          if (response.version !== 1 || response.requestId !== requestId) {
            fail(new Error('Rust device bridge returned a mismatched event response'));
            return;
          }
          if (!response.ok) {
            fail(new DeviceBridgeError(response.error?.code ?? 'device_bridge_error', response.error?.message ?? 'Rust device bridge event subscription failed', response.error?.retryable ?? false));
            return;
          }
          const value = response.result;
          if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).type !== 'string' || typeof (value as Record<string, unknown>).sequence !== 'number' || !Array.isArray((value as Record<string, unknown>).devices)) {
            fail(new Error('Rust device bridge returned an invalid device event'));
            return;
          }
          if (!opened) {
            opened = true;
            resolve(stop);
          }
          onEvent(value as RustDeviceBridgeEvent);
        }
      };
      socket.setTimeout(0);
      socket.on('data', receive);
      socket.once('error', fail);
      socket.once('close', () => {
        if (!stopped && opened) onError?.(new Error('Rust device bridge event stream closed'));
        if (!opened && !stopped) reject(new Error('Rust device bridge event stream closed before the first snapshot'));
      });
      signal?.addEventListener('abort', stop, { once: true });
      socket.write(frame, (error) => {
        if (error) fail(error);
      });
    });
  }

  async fileRead(deviceId: string, agentSecret: string, remotePath: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<string> {
    const envelope = createDeviceAgentEnvelope(agentSecret, randomUUID(), { action: 'exec', command: `cat -- ${shellQuote(remotePath)}`, timeoutMs });
    const result = await this.request('file_read', { deviceId, agentSecret, payload: envelope }, timeoutMs + 1_000);
    const value = parseDeviceAgentResponse(agentSecret, result as DeviceAgentEnvelope);
    return typeof value.stdout === 'string' ? value.stdout : '';
  }

  async fileWrite(deviceId: string, agentSecret: string, remotePath: string, content: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS): Promise<void> {
    if (content.length > 16 * 1024 * 1024) throw new Error('device bridge file write exceeds the allowed size');
    const command = `printf %s ${shellQuote(content)} > ${shellQuote(remotePath)}`;
    const envelope = createDeviceAgentEnvelope(agentSecret, randomUUID(), { action: 'exec', command, timeoutMs });
    const result = await this.request('file_write', { deviceId, agentSecret, payload: envelope }, timeoutMs + 1_000);
    const value = parseDeviceAgentResponse(agentSecret, result as DeviceAgentEnvelope);
    if (value.code !== 0) throw new Error(typeof value.stderr === 'string' && value.stderr ? value.stderr : 'device bridge file write failed');
  }
}

class RustDeviceAgentClient implements DeviceAgentClient {
  readonly transport = 'autoinstall' as const;
  private closed = false;
  private readonly bridge = new RustDeviceBridgeClient();
  private readonly abortController = new AbortController();
  private readonly pendingRequests = new Set<AbortController>();

  constructor(readonly deviceId: string, readonly secret: string, readonly rootDir: string) {}

  get isUnusable(): boolean {
    return this.closed;
  }

  async call(action: string, payload: Record<string, unknown>, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closed) throw new Error('Rust device agent session is closed');
    const requestId = randomUUID();
    const envelope = createDeviceAgentEnvelope(this.secret, requestId, { action, ...payload });
    const requestController = new AbortController();
    this.pendingRequests.add(requestController);
    const requestSignal = signal
      ? AbortSignal.any([this.abortController.signal, requestController.signal, signal])
      : AbortSignal.any([this.abortController.signal, requestController.signal]);
    try {
      const result = await this.bridge.request('agent', { deviceId: this.deviceId, agentSecret: this.secret, payload: envelope }, timeoutMs + 1_000, requestSignal);
      if (!result || typeof result !== 'object') throw new Error('Rust device bridge returned an invalid agent response');
      return parseDeviceAgentResponse(this.secret, result as DeviceAgentEnvelope);
    } catch (error) {
      if (!requestController.signal.aborted && !signal?.aborted) this.closed = true;
      throw error;
    } finally {
      this.pendingRequests.delete(requestController);
    }
  }

  async exec(command: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
    const result = await this.call('exec', { command, timeoutMs }, timeoutMs + 1_000, signal);
    return { stdout: typeof result.stdout === 'string' ? result.stdout : '', stderr: typeof result.stderr === 'string' ? result.stderr : '', code: typeof result.code === 'number' ? result.code : null };
  }

  close(): void {
    if (!this.closed) this.abortController.abort(new Error('Rust device agent session is closed'));
    this.closed = true;
  }

  cancelPending(): void {
    for (const controller of this.pendingRequests) controller.abort(new Error('Rust device agent request cancelled'));
  }
}

const sshSessions = new Map<string, SshSession>();
const sshCommandSignals = new WeakMap<Client, AbortSignal>();
interface DeviceAgentSession {
  client: DeviceAgentClient;
  idleTimer?: NodeJS.Timeout;
}

const deviceAgentSessions = new Map<string, DeviceAgentSession>();

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

async function resolveDeviceAuth(connection: DeviceConnection | string): Promise<{ auth: DeviceAuth; rootDir: string; usesUsbmux: boolean }> {
  if (typeof connection === 'string') {
    return { auth: await loadDeviceAuth(connection), rootDir: connection, usesUsbmux: false };
  }
  if (!connection.host && !connection.udid && connection.rootDir) {
    return { auth: await loadDeviceAuth(connection.rootDir), rootDir: connection.rootDir, usesUsbmux: false };
  }
  return {
    auth: directDeviceAuth(connection),
    rootDir: connectionRuntimeRoot(connection),
    usesUsbmux: !connection.host && Boolean(connection.udid),
  };
}

async function openDeviceAgentSession(connection: DeviceConnection, key: string, signal?: AbortSignal): Promise<DeviceAgentSession> {
  if (!isRustDeviceConnection(connection)) throw new Error('the autoinstall device agent requires a paired Rust device connection');
  if (!connection.udid) throw new Error('the autoinstall device agent requires a device identifier');
  const rootDir = connectionRuntimeRoot(connection);
  const secret = await loadBridgeSecret(rootDir);
  const capabilities = await new RustDeviceBridgeClient().capabilities(signal);
  const supported = Array.isArray(capabilities.capabilities) && capabilities.capabilities.includes('agent');
  if (!supported) throw new DeviceAgentUnavailableError('the Rust device bridge does not support the autoinstall agent capability');
  const client = new RustDeviceAgentClient(connection.udid, secret, rootDir);
  try {
    await client.call('status', {}, 3_000, signal);
    const session: DeviceAgentSession = { client };
    deviceAgentSessions.set(key, session);
    log.info('connected to the dkrypt device agent through the Rust device bridge', { deviceId: key });
    return session;
  } catch (error) {
    client.close();
    throw error;
  }
}

export async function pairDevice(connection: DeviceConnection): Promise<{ deviceId: string; hostId: string; paired: boolean }> {
  if (!connection.udid || connection.host || connection.usbmuxNetwork === true) throw new Error('Rust pairing requires a direct USB device');
  return new RustDeviceBridgeClient().pair(connection.udid, config.deviceBridgeHostId || undefined);
}

function closeDeviceAgentSession(key: string, session: DeviceAgentSession): void {
  if (deviceAgentSessions.get(key) === session) deviceAgentSessions.delete(key);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.client.close();
}

async function getDeviceAgentSession(connection: DeviceConnection, signal?: AbortSignal): Promise<{ key: string; session: DeviceAgentSession }> {
  throwIfAborted(signal);
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
      return { key, session: await openDeviceAgentSession(connection, key, signal) };
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      if (attempt + 1 < DEVICE_AGENT_CONNECT_RETRIES) {
        await delayWithSignal(getDeviceAgentRetryDelay(attempt), signal);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function getDeviceAgentRetryDelay(attempt: number): number {
  return Math.min(DEVICE_AGENT_RETRY_DELAY_MS * 2 ** Math.max(0, attempt), 5_000);
}

export async function retryRustDeviceHealthProbe(
  operation: () => Promise<{ state: string; transport: string; deviceCount: number; devicePresent: boolean }>,
  attempts = 3,
  delayMs = 250,
): Promise<{ state: string; transport: string; deviceCount: number; devicePresent: boolean }> {
  let lastError: unknown;
  const totalAttempts = Math.max(1, attempts);
  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    try {
      const result = await operation();
      if (result.devicePresent || attempt + 1 >= totalAttempts) return result;
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= totalAttempts) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, delayMs) * 2 ** attempt));
  }
  throw lastError instanceof Error ? lastError : new Error('Rust device bridge health probe did not return a result');
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

async function withDeviceTunnel<T>(connection: DeviceConnection | string, fn: (auth: DeviceAuth, rootDir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const resolved = await resolveDeviceAuth(connection);
  throwIfAborted(signal);
  if (!resolved.usesUsbmux) return fn(resolved.auth, resolved.rootDir);
  if (typeof connection === 'string' || !connection.udid) throw new Error('a paired device identifier is required for USB setup');
  const bridge = new RustDeviceBridgeClient();
  const tunnel = await bridge.openTunnel(connection.udid, resolved.auth.port, undefined, signal);
  try {
    throwIfAborted(signal);
    return await fn({ ...resolved.auth, host: tunnel.host, port: tunnel.port }, resolved.rootDir);
  } finally {
    await bridge.closeTunnel(tunnel.tunnelId).catch(() => {});
  }
}

export async function probeDeviceSshTunnel(connection: DeviceConnection, signal?: AbortSignal): Promise<boolean> {
  const startedAt = performance.now();
  let ready = false;
  try {
    await withDeviceTunnel(connection, async (auth) => {
      const privateKey = await readFile(auth.keyPath);
      throwIfAborted(signal);
      const client = await retryTransientSshConnection(
        () => connectSshClient(auth, privateKey, signal, 5_000),
        SSH_HANDSHAKE_RETRIES,
        SSH_HANDSHAKE_RETRY_DELAY_MS,
        signal,
      );
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          let timeout: NodeJS.Timeout;
          const finish = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
            if (error) reject(error);
            else resolve();
          };
          const onAbort = () => finish(abortedOperationError(signal as AbortSignal));
          timeout = setTimeout(() => finish(new Error('SSH SFTP subsystem probe timed out')), SSH_SFTP_PROBE_TIMEOUT_MS);
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
            return;
          }
          client.sftp((error, sftp) => {
            if (error) {
              finish(error);
              return;
            }
            sftp.end();
            finish();
          });
        });
      } finally {
        client.end();
      }
    }, signal);
    throwIfAborted(signal);
    ready = true;
    return ready;
  } catch {
    throwIfAborted(signal);
    return ready;
  } finally {
    incrementMetric('device_ssh_sftp_probes_total', { outcome: ready ? 'ready' : 'unavailable' });
    observeMetric('device_ssh_sftp_probe_duration_ms', performance.now() - startedAt);
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

export async function retryTransientSshConnection<T>(operation: () => Promise<T>, maxRetries = SSH_HANDSHAKE_RETRIES, delayMs = SSH_HANDSHAKE_RETRY_DELAY_MS, signal?: AbortSignal): Promise<T> {
  let retries = 0;
  while (true) {
    throwIfAborted(signal);
    try {
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      throwIfAborted(signal);
      if (!isTransientSshConnectionError(error) || retries >= maxRetries) throw error;
      retries += 1;
      await delayWithSignal(delayMs, signal);
    }
  }
}

function connectSshClient(auth: DeviceAuth, privateKey: Buffer, signal?: AbortSignal, readyTimeoutMs = 15_000): Promise<Client> {
  const conn = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      conn.destroy();
      reject(error);
    };
    const onAbort = () => fail(abortedOperationError(signal as AbortSignal));
    conn.on('error', fail);
    conn.once('ready', () => {
      settled = true;
      cleanup();
      resolve(conn);
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
      if (settled) return;
      conn.connect({ host: auth.host, port: auth.port, username: auth.user, privateKey, readyTimeout: readyTimeoutMs });
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
}

async function openSshSession(connection: DeviceConnection | string, key: string, signal?: AbortSignal): Promise<SshSession> {
  throwIfAborted(signal);
  const resolved = await resolveDeviceAuth(connection);
  throwIfAborted(signal);
  if (resolved.usesUsbmux) throw new DeviceAgentUnavailableError('direct USB SSH requires the Rust device bridge tunnel');
  let privateKey: Buffer;
  try {
    privateKey = await readFile(resolved.auth.keyPath);
    throwIfAborted(signal);
  } catch (err) {
    invalidateAuthCache(connection);
    throw err;
  }
  try {
    const conn = await retryTransientSshConnection(() => connectSshClient(resolved.auth, privateKey, signal), SSH_HANDSHAKE_RETRIES, SSH_HANDSHAKE_RETRY_DELAY_MS, signal);
    const session: SshSession = { conn, rootDir: resolved.rootDir, unusable: false };
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
    throw err;
  }
}

async function getSshSession(connection: DeviceConnection | string, signal?: AbortSignal): Promise<{ key: string; session: SshSession }> {
  throwIfAborted(signal);
  const key = sshSessionKey(connection);
  const existing = sshSessions.get(key);
  if (existing && !existing.unusable) {
    if (existing.idleTimer) clearTimeout(existing.idleTimer);
    existing.idleTimer = undefined;
    return { key, session: existing };
  }
  if (existing) closeSshSession(key, existing);
  return { key, session: await openSshSession(connection, key, signal) };
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

export function isRustDeviceConnection(connection: DeviceConnection | string): connection is DeviceConnection {
  return typeof connection !== 'string' && Boolean(connection.udid && !connection.host);
}

export function isDirectUsbDeviceAgentConnection(connection: DeviceConnection | string): connection is DeviceConnection {
  return isRustDeviceConnection(connection) && connection.usbmuxNetwork !== true;
}

export async function getRustDeviceBridgeHealth(connection: DeviceConnection): Promise<{ state: 'ready' | 'offline'; transport: DeviceTransport; deviceCount: number; capabilities: string[] }> {
  if (!isRustDeviceConnection(connection)) throw new DeviceAgentUnavailableError('Rust device bridge is unavailable for this connection');
  const bridge = new RustDeviceBridgeClient();
  const [health, capabilities] = await Promise.all([retryRustDeviceHealthProbe(() => bridge.health(connection.udid)), bridge.capabilities()]);
  const values = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((value): value is string => typeof value === 'string') : [];
  return { state: health.devicePresent && health.state === 'ready' ? 'ready' : 'offline', transport: connection.usbmuxNetwork ? 'wifi' : 'usb', deviceCount: health.deviceCount, capabilities: values };
}

export interface RustDeviceBridgeStatus {
  state: 'ready' | 'offline';
  transport: string;
  deviceCount: number;
  capabilities: string[];
}

export async function getRustDeviceBridgeStatus(): Promise<RustDeviceBridgeStatus> {
  const bridge = new RustDeviceBridgeClient();
  const [health, capabilities] = await Promise.all([bridge.health(), bridge.capabilities()]);
  const values = Array.isArray(capabilities.capabilities) ? capabilities.capabilities.filter((value): value is string => typeof value === 'string') : [];
  return {
    state: health.state === 'ready' ? 'ready' : 'offline',
    transport: health.transport,
    deviceCount: health.deviceCount,
    capabilities: values,
  };
}

export async function subscribeRustDeviceBridgeEvents(onEvent: (event: RustDeviceBridgeEvent) => void, onError?: (error: Error) => void, signal?: AbortSignal): Promise<() => void> {
  return new RustDeviceBridgeClient().subscribeEvents(onEvent, onError, signal);
}

export function getDeviceTransportOrder(connection: DeviceConnection | string, mode = config.deviceTransport): Array<'autoinstall' | 'ssh'> {
  const normalizedMode = mode.toLowerCase();
  if (typeof connection !== 'string' && isRustDeviceConnection(connection)) return ['autoinstall'];
  if (normalizedMode === 'ssh') return ['ssh'];
  if (typeof connection === 'string' || !isRustDeviceConnection(connection)) return ['ssh'];
  return normalizedMode === 'autoinstall' ? ['autoinstall'] : ['autoinstall', 'ssh'];
}

async function withDeviceAgent<T>(connection: DeviceConnection, fn: (client: DeviceClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withSSHLock(async () => {
    throwIfAborted(signal);
    let opened: { key: string; session: DeviceAgentSession };
    try {
      opened = await getDeviceAgentSession(connection, signal);
    } catch (error) {
      throwIfAborted(signal);
      const detail = error instanceof Error ? error.message : String(error);
      throw new DeviceAgentUnavailableError(`could not connect to the dkrypt device agent: ${detail}`, { cause: error });
    }
    const cancelPending = () => opened.session.client.cancelPending();
    signal?.addEventListener('abort', cancelPending, { once: true });
    try {
      throwIfAborted(signal);
      const result = await fn(opened.session.client);
      throwIfAborted(signal);
      return result;
    } catch (error) {
      throwIfAborted(signal);
      if (opened.session.client.isUnusable) {
        throw new DeviceAgentUnavailableError('the dkrypt device agent connection was lost', { cause: error });
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancelPending);
      releaseDeviceAgentSession(opened.key, opened.session);
    }
  });
}

export async function withAutoinstallDeviceAgent<T>(connection: DeviceConnection, fn: (client: DeviceClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!isDirectUsbDeviceAgentConnection(connection)) throw new DeviceAgentUnavailableError('the direct USB recovery channel is unavailable for this device');
  return withDeviceAgent(connection, fn, signal);
}

export async function withSSH<T>(connection: DeviceConnection | string, fn: (conn: DeviceClient) => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  const transportOrder = getDeviceTransportOrder(connection);
  if (transportOrder[0] === 'autoinstall' && isRustDeviceConnection(connection)) {
    return withDeviceAgent(connection as DeviceConnection, fn, signal);
  }
  return withSSHLock(async () => {
    throwIfAborted(signal);
    let key = '';
    let session: SshSession | undefined;
    let clearCommandSignal: (() => void) | undefined;
    try {
      const opened = await getSshSession(connection, signal);
      key = opened.key;
      session = opened.session;
      throwIfAborted(signal);
      if (signal) {
        const currentConnection = session.conn;
        clearCommandSignal = () => sshCommandSignals.delete(currentConnection);
        sshCommandSignals.set(currentConnection, signal);
        signal.addEventListener('abort', clearCommandSignal, { once: true });
      }
      const result = await fn(session.conn);
      throwIfAborted(signal);
      return result;
    } catch (err) {
      throwIfAborted(signal);
      invalidateAuthCache(connection);
      if (session && (session.unusable || isTransientSshConnectionError(err))) closeSshSession(key, session);
      throw err;
    } finally {
      if (clearCommandSignal) signal?.removeEventListener('abort', clearCommandSignal);
      if (session) {
        if (signal && sshCommandSignals.get(session.conn) === signal) sshCommandSignals.delete(session.conn);
        releaseSshSession(key, session);
      }
    }
  });
}

export async function withIpadecrypt<T>(connection: DeviceConnection | string, fn: (rootDir: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return withDeviceTunnel(connection, async (auth, rootDir) => {
    throwIfAborted(signal);
    const runtimeRoot = typeof connection === 'string' ? rootDir : await ensureIpadecryptRuntime(rootDir, auth);
    throwIfAborted(signal);
    return fn(runtimeRoot);
  }, signal);
}

async function discoverRustDevices(): Promise<DeviceDiscoveryResult> {
  const bridge = new RustDeviceBridgeClient();
  const warnings: string[] = [];
  let listed: unknown;
  try {
    listed = await bridge.request('list_devices', {}, 5_000);
  } catch (error) {
    return { devices: [], scannedNetworks: [], warnings: [error instanceof Error ? error.message : String(error)] };
  }
  if (!Array.isArray(listed)) return { devices: [], scannedNetworks: [], warnings: ['Rust device bridge returned an invalid device list'] };
  const devices: DeviceDiscoveryCandidate[] = [];
  for (const entry of listed) {
    if (!entry || typeof entry !== 'object') continue;
    const value = entry as Record<string, unknown>;
    const udid = typeof value.udid === 'string' ? value.udid : typeof value.id === 'string' ? value.id.replace(/^id:/, '') : undefined;
    if (!udid) continue;
    const transport = typeof value.transport === 'string' && value.transport.startsWith('wifi') ? 'wifi' : 'usb';
    let metadata: Record<string, unknown> = {};
    try {
      const result = await bridge.request('metadata', { deviceId: udid }, 5_000);
      if (result && typeof result === 'object') metadata = result as Record<string, unknown>;
    } catch (error) {
      warnings.push(`Could not read metadata for ${udid}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const name = typeof metadata.DeviceName === 'string' ? metadata.DeviceName : typeof metadata.ProductType === 'string' ? metadata.ProductType : `${transport === 'usb' ? 'USB' : 'Wi-Fi'} iDevice`;
    devices.push({
      discoveryId: `${transport}-${udid}`,
      name,
      transport,
      port: config.deviceSshPort,
      user: config.deviceSshUser,
      udid,
      usbmuxNetwork: transport === 'wifi',
      productType: typeof metadata.ProductType === 'string' ? metadata.ProductType : undefined,
      productVersion: typeof metadata.ProductVersion === 'string' ? metadata.ProductVersion : undefined,
      source: transport,
    });
  }
  return { devices, scannedNetworks: [], warnings };
}

export async function discoverDevices(): Promise<DeviceDiscoveryResult> {
  return discoverRustDevices();
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
  if (isDirectUsbDeviceAgentConnection(connection)) await pairDevice(connection);
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
        ? 'The Rust USB device agent is not responding'
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
    throw new Error(`${typeof details.code === 'string' ? details.code : 'device_agent_error'}: ${typeof details.message === 'string' ? details.message : 'device agent request failed'}`);
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

export function execCommand(conn: DeviceClient, command: string, timeoutMs = REMOTE_COMMAND_TIMEOUT_MS, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
  if (isDeviceSession(conn)) return conn.exec(command, timeoutMs, signal);
  const commandSignal = signal ?? sshCommandSignals.get(conn);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stream: Channel | undefined;
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const effectiveTimeoutMs = Math.max(1, timeoutMs);
    const cleanupSignal = () => commandSignal?.removeEventListener('abort', abort);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      stream?.destroy();
      reject(error);
    };
    const abort = () => fail(abortedOperationError(commandSignal as AbortSignal));
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanupSignal();
      stream?.destroy();
      resolve({ stdout, stderr: `${stderr}\ncommand timed out after ${effectiveTimeoutMs}ms`.trim(), code: null });
    }, effectiveTimeoutMs);
    commandSignal?.addEventListener('abort', abort, { once: true });
    if (commandSignal?.aborted) {
      abort();
      return;
    }
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
          cleanupSignal();
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
  try {
    await writeRemoteFile(conn, tempPath, content, timeoutMs);
    const { code, stderr } = await execCommand(conn, `mv ${shellQuote(tempPath)} ${shellQuote(remotePath)}`, timeoutMs);
    if (code !== 0) throw new Error(`could not publish bridge request: ${stderr || code}`);
  } catch (error) {
    await execCommand(conn, `rm -f ${shellQuote(tempPath)}`, Math.max(1, Math.min(timeoutMs, 5_000))).catch(() => {});
    throw error;
  }
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
  return writeRemoteFile(conn, AUTOCONFIRM_FLAG_PATH, `expiresAtMs=${Date.now() + AUTOCONFIRM_TTL_MS}\n${label}`);
}

export async function clearAppStoreAutoConfirm(conn: DeviceClient): Promise<void> {
  await execCommand(conn, `rm -f ${AUTOCONFIRM_FLAG_PATHS.map(shellQuote).join(' ')}`);
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
  signal?: AbortSignal,
): Promise<any> {
  return withBridgeLock(async () => {
    throwIfAborted(signal);
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
    let requestMayExist = false;
    let completed = false;
    log.info('sending authenticated autoinstall bridge request', { requestId, channel, action: request.action });
    try {
      const { code, stderr } = await execCommand(
        conn,
        `mkdir -p "${requestDirectory}" "${responseDirectory}" && chmod 700 "${BRIDGE_ROOT_PATH}" "${BRIDGE_ROOT_PATH}/${channel}" "${requestDirectory}" "${responseDirectory}"`,
        commandTimeout(),
      );
      throwIfAborted(signal);
      if (code !== 0) throw new Error(`could not prepare autoinstall bridge directories: ${stderr || code}`);
      await writeRemoteFileAtomically(conn, BRIDGE_SECRET_REMOTE_PATH, `${secret}\n`, commandTimeout());
      throwIfAborted(signal);
      const secretMode = await execCommand(conn, `chmod 600 "${BRIDGE_SECRET_REMOTE_PATH}"`, commandTimeout());
      throwIfAborted(signal);
      if (secretMode.code !== 0) throw new Error(`could not secure autoinstall bridge secret: ${secretMode.stderr || secretMode.code}`);
      await execCommand(conn, `find "${BRIDGE_ROOT_PATH}" -type f -mmin +${BRIDGE_ARTIFACT_TTL_MINUTES} -delete`, commandTimeout());
      throwIfAborted(signal);
      requestMayExist = true;
      await writeRemoteFileAtomically(conn, requestPath, JSON.stringify(envelope), commandTimeout());
      throwIfAborted(signal);

      while (Date.now() < deadline) {
        throwIfAborted(signal);
        const raw = await readRemoteFileIfExists(conn, responsePath, commandTimeout());
        throwIfAborted(signal);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (typeof parsed.requestId === 'string' && parsed.requestId !== requestId) {
            log.warn('discarding autoinstall bridge response with a mismatched request id', { requestId, responseRequestId: parsed.requestId, channel });
            await execCommand(conn, `rm -f ${responsePath}`, commandTimeout());
            throwIfAborted(signal);
            continue;
          }
          await execCommand(conn, `rm -f "${responsePath}"`, commandTimeout());
          throwIfAborted(signal);
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
          completed = true;
          return { ...parsed, requestId };
        }
        await delayWithSignal(Math.min(500, Math.max(1, deadline - Date.now())), signal);
      }
      throw new Error(`autoinstall bridge request timed out (${requestId}) on ${channel}: ${JSON.stringify(request)}`);
    } finally {
      if (requestMayExist && !completed) await execCommand(conn, `rm -f "${requestPath}" "${responsePath}"`, Math.min(5_000, REMOTE_COMMAND_TIMEOUT_MS)).catch(() => {});
    }
  });
}

export function sendTestFlightBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'testflight', request, timeoutMs, signal);
}

export function sendSpringBoardBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'springboard', request, timeoutMs, signal);
}

export function sendAppStoreBridgeRequest(conn: DeviceClient, request: Record<string, unknown>, timeoutMs = 20_000, signal?: AbortSignal): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'appstore', request, timeoutMs, signal);
}

export async function tryIoregCandidates(conn: DeviceClient, ioregClass: string, candidates: string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${ioregClass} -w 0 2>&1`);
    if (code === 0 && stdout.includes(ioregClass)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}
