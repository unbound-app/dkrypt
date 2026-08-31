import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { Client } from 'ssh2';
import { scopedLogger } from '#logger.js';
import { BRIDGE_PROTOCOL_VERSION } from '#bridgeProtocol.js';
import type { BridgeChannel } from '#bridgeProtocol.js';

const log = scopedLogger('idevice');

const AUTOCONFIRM_FLAG_PATH = '/tmp/autoinstall-autoconfirm.flag';
const BRIDGE_ROOT_PATH = '/tmp/autoinstall/v1';
const BRIDGE_SECRET_FILE_NAME = 'autoinstall-bridge-secret';
const BRIDGE_SECRET_REMOTE_PATH = '/var/mobile/Library/Preferences/dev.adrian.autoinstall-bridge.secret';
const BRIDGE_ARTIFACT_TTL_MINUTES = 30;

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

export async function withSSH<T>(rootDir: string, fn: (conn: Client) => Promise<T>): Promise<T> {
  return withSSHLock(async () => {
    const auth = await loadDeviceAuth(rootDir);
    let privateKey: Buffer;
    try {
      privateKey = await readFile(auth.keyPath);
    } catch (err) {
      authCache.delete(rootDir);
      throw err;
    }
    const conn = new Client();
    try {
      await new Promise<void>((resolve, reject) => {
        conn.on('ready', () => resolve());
        conn.on('error', reject);
        conn.connect({ host: auth.host, port: auth.port, username: auth.user, privateKey, readyTimeout: 15_000 });
      });
      connectionRoots.set(conn, rootDir);
      return await fn(conn);
    } catch (err) {
      authCache.delete(rootDir);
      throw err;
    } finally {
      connectionRoots.delete(conn);
      conn.end();
    }
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

export function execCommand(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) return reject(err);
      let stdout = '';
      let stderr = '';
      stream.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      stream.on('close', (code: number | null) => resolve({ stdout, stderr, code }));
      stream.on('error', reject);
    });
  });
}

function writeRemoteFile(conn: Client, remotePath: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const stream = sftp.createWriteStream(remotePath);
      stream.on('close', () => {
        sftp.end();
        resolve();
      });
      stream.on('error', (streamErr: Error) => {
        sftp.end();
        reject(streamErr);
      });
      stream.end(content);
    });
  });
}

async function writeRemoteFileAtomically(conn: Client, remotePath: string, content: string): Promise<void> {
  const tempPath = `${remotePath}.${randomUUID()}.partial`;
  await writeRemoteFile(conn, tempPath, content);
  const { code, stderr } = await execCommand(conn, `mv "${tempPath}" "${remotePath}"`);
  if (code !== 0) throw new Error(`could not publish bridge request: ${stderr || code}`);
}

function readRemoteFileIfExists(conn: Client, remotePath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        sftp.end();
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
      stream.on('error', (streamErr: NodeJS.ErrnoException) => {
        sftp.end();
        if (streamErr.code === 'ENOENT' || streamErr.message?.includes('No such file')) {
          resolve(undefined);
        } else {
          reject(streamErr);
        }
      });
    });
  });
}

export async function readBridgeHeartbeats(conn: Client): Promise<Partial<Record<BridgeChannel, BridgeHeartbeat>>> {
  const channels: BridgeChannel[] = ['springboard', 'testflight', 'appstore'];
  const entries = await Promise.all(channels.map(async (channel) => {
    const raw = await readRemoteFileIfExists(conn, `${BRIDGE_ROOT_PATH}/${channel}/state/heartbeat.json`);
    if (!raw) return [channel, undefined] as const;
    try {
      return [channel, JSON.parse(raw) as BridgeHeartbeat] as const;
    } catch {
      return [channel, undefined] as const;
    }
  }));
  return Object.fromEntries(entries.filter((entry): entry is [BridgeChannel, BridgeHeartbeat] => entry[1] !== undefined));
}

export async function isTestFlightRunning(conn: Client): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i '/TestFlight$' | grep -v grep");
  return stdout.trim().length > 0;
}

export async function isAppStoreRunning(conn: Client): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i 'AppStore.app/AppStore$' | grep -v grep");
  return stdout.trim().length > 0;
}

export function armAppStoreAutoConfirm(conn: Client, label = 'Install'): Promise<void> {
  return writeRemoteFile(conn, AUTOCONFIRM_FLAG_PATH, label);
}

export async function clearAppStoreAutoConfirm(conn: Client): Promise<void> {
  await execCommand(conn, `rm -f ${AUTOCONFIRM_FLAG_PATH}`);
}

export async function uninstallInstalledApp(conn: Client, bundleId: string): Promise<boolean> {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)) return false;

  const { stdout, code } = await execCommand(conn, `uicache -i "${bundleId}" 2>/dev/null`);
  if (code !== 0) return false;

  const foundId = stdout.match(/^Bundle Identifier:\s*(.+)$/m)?.[1]?.trim();
  const appPath = stdout.match(/^Path:\s*(.+)$/m)?.[1]?.trim();
  const removable = /^Removable:\s*true\s*$/m.test(stdout);

  if (foundId !== bundleId || !appPath || !removable) return false;
  return uninstallInstalledBundle(conn, bundleId, appPath);
}

export async function uninstallInstalledBundle(conn: Client, bundleId: string, appPath: string): Promise<boolean> {
  if (!/^[A-Za-z0-9.-]{1,200}$/.test(bundleId)) return false;
  if (!appPath.endsWith('.app') || !appPath.includes('/var/containers/Bundle/Application/')) return false;

  const container = appPath.replace(/\/[^/]+\.app$/, '');
  if (!/\/var\/containers\/Bundle\/Application\/[^/]+$/.test(container)) return false;

  const { code } = await execCommand(conn, `sudo /var/jb/usr/bin/uicache -u "${appPath}" 2>/dev/null; sudo rm -rf "${container}"`);
  if (code !== 0) return false;
  log.info('uninstalled app from device', { bundleId });
  return true;
}

export async function findInstalledAppStoreBundle(conn: Client, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `for d in /var/containers/Bundle/Application/*/*.app; do ` +
      `if [ -d "$d/SC_Info" ] && grep -laq "${bundleId}" "$d/Info.plist" 2>/dev/null; then echo "$d"; break; fi; done`,
  );
  const line = stdout.trim().split('\n')[0];
  return line || undefined;
}

export async function listInstalledAppStoreBundles(conn: Client): Promise<string[]> {
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

export async function readInstalledBundleVersions(conn: Client, appPath: string): Promise<InstalledBundleVersions> {
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
  conn: Client,
  channel: BridgeChannel,
  request: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<any> {
  return withBridgeLock(async () => {
    const requestId = typeof request.requestId === 'string' ? request.requestId : randomUUID();
    const rootDir = connectionRoots.get(conn);
    if (!rootDir) throw new Error('autoinstall bridge requests must run through withSSH');
    const secret = await loadBridgeSecret(rootDir);
    const requestDirectory = `${BRIDGE_ROOT_PATH}/${channel}/requests`;
    const responseDirectory = `${BRIDGE_ROOT_PATH}/${channel}/responses`;
    const requestPath = `${requestDirectory}/${requestId}.json`;
    const responsePath = `${responseDirectory}/${requestId}.response.json`;
    const envelope = createBridgeEnvelope(secret, channel, request, requestId);
    log.info('sending authenticated autoinstall bridge request', { requestId, channel, action: request.action });
    const { code, stderr } = await execCommand(
      conn,
      `mkdir -p "${requestDirectory}" "${responseDirectory}" && chmod 700 "${BRIDGE_ROOT_PATH}" "${BRIDGE_ROOT_PATH}/${channel}" "${requestDirectory}" "${responseDirectory}"`,
    );
    if (code !== 0) throw new Error(`could not prepare autoinstall bridge directories: ${stderr || code}`);
    await writeRemoteFileAtomically(conn, BRIDGE_SECRET_REMOTE_PATH, `${secret}\n`);
    const secretMode = await execCommand(conn, `chmod 600 "${BRIDGE_SECRET_REMOTE_PATH}"`);
    if (secretMode.code !== 0) throw new Error(`could not secure autoinstall bridge secret: ${secretMode.stderr || secretMode.code}`);
    await execCommand(conn, `find "${BRIDGE_ROOT_PATH}" -type f -mmin +${BRIDGE_ARTIFACT_TTL_MINUTES} -delete`);
    await writeRemoteFileAtomically(conn, requestPath, JSON.stringify(envelope));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await readRemoteFileIfExists(conn, responsePath);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.requestId === 'string' && parsed.requestId !== requestId) {
          log.warn('discarding autoinstall bridge response with a mismatched request id', { requestId, responseRequestId: parsed.requestId, channel });
          await execCommand(conn, `rm -f ${responsePath}`);
          continue;
        }
        await execCommand(conn, `rm -f "${responsePath}"`);
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
      await new Promise((r) => setTimeout(r, 500));
    }
    await execCommand(conn, `rm -f "${requestPath}" "${responsePath}"`);
    throw new Error(`autoinstall bridge request timed out (${requestId}) on ${channel}: ${JSON.stringify(request)}`);
  });
}

export function sendTestFlightBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'testflight', request, timeoutMs);
}

export function sendSpringBoardBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'springboard', request, timeoutMs);
}

export function sendAppStoreBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, 'appstore', request, timeoutMs);
}

export async function tryIoregCandidates(conn: Client, ioregClass: string, candidates: string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${ioregClass} -w 0 2>&1`);
    if (code === 0 && stdout.includes(ioregClass)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}
