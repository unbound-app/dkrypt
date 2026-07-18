import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'ssh2';
import { scopedLogger } from './logger.js';

const log = scopedLogger('idevice');

const REQUEST_PATH = '/tmp/tfauto-request.json';
const RESPONSE_PATH = '/tmp/tfauto-response.json';
const SB_REQUEST_PATH = '/tmp/tfauto-sb-request.json';
const SB_RESPONSE_PATH = '/tmp/tfauto-sb-response.json';

interface DeviceAuth {
  host: string;
  port: number;
  user: string;
  keyPath: string;
}

interface RawIpadecryptConfig {
  device?: {
    host?: string;
    port?: number;
    user?: string;
    auth?: { keyPath?: string };
  };
}

// Keyed by device root dir (the ipadecrypt --root-dir a device was bootstrapped against) so
// each registered device's connection info is cached and invalidated independently.
const authCache = new Map<string, DeviceAuth>();

async function loadDeviceAuth(rootDir: string): Promise<DeviceAuth> {
  const cached = authCache.get(rootDir);
  if (cached) return cached;
  const configPath = path.join(rootDir, 'config.json');
  const raw = JSON.parse(await readFile(configPath, 'utf8')) as RawIpadecryptConfig;
  const device = raw.device;
  if (!device?.host || !device.port || !device.user || !device.auth?.keyPath) {
    throw new Error(`ipadecrypt config at ${configPath} is missing device connection info (host/port/user/auth.keyPath)`);
  }
  const auth: DeviceAuth = { host: device.host, port: device.port, user: device.user, keyPath: device.auth.keyPath };
  authCache.set(rootDir, auth);
  return auth;
}

// Throws if the given root dir's config.json can't be read or is missing device connection
// info - used to validate a device's root dir before it's accepted into the dashboard.
export async function validateDeviceRootDir(rootDir: string): Promise<void> {
  authCache.delete(rootDir);
  await loadDeviceAuth(rootDir);
}

export async function withSSH<T>(rootDir: string, fn: (conn: Client) => Promise<T>): Promise<T> {
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
    return await fn(conn);
  } catch (err) {
    authCache.delete(rootDir);
    throw err;
  } finally {
    conn.end();
  }
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
      stream.on('close', () => resolve());
      stream.on('error', reject);
      stream.end(content);
    });
  });
}

function readRemoteFileIfExists(conn: Client, remotePath: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    conn.sftp((err, sftp) => {
      if (err) return reject(err);
      const chunks: Buffer[] = [];
      const stream = sftp.createReadStream(remotePath);
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      stream.on('error', (streamErr: NodeJS.ErrnoException) => {
        if (streamErr.code === 'ENOENT' || streamErr.message?.includes('No such file')) {
          resolve(undefined);
        } else {
          reject(streamErr);
        }
      });
    });
  });
}

export async function isTestFlightRunning(conn: Client): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i '/TestFlight$' | grep -v grep");
  return stdout.trim().length > 0;
}

let bridgeQueue: Promise<unknown> = Promise.resolve();

function withBridgeLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = bridgeQueue.then(fn, fn);
  bridgeQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function sendBridgeRequestRawTo(
  conn: Client,
  requestPath: string,
  responsePath: string,
  request: Record<string, unknown>,
  timeoutMs = 20_000,
): Promise<any> {
  return withBridgeLock(async () => {
    await execCommand(conn, `rm -f ${responsePath}`);
    await writeRemoteFile(conn, requestPath, JSON.stringify(request));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await readRemoteFileIfExists(conn, responsePath);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.ok === false) throw new Error(`tfauto bridge error: ${parsed.error}`);
        return parsed;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`tfauto bridge request timed out: ${JSON.stringify(request)}`);
  });
}

export function sendTestFlightBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, REQUEST_PATH, RESPONSE_PATH, request, timeoutMs);
}

export function sendSpringBoardBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, SB_REQUEST_PATH, SB_RESPONSE_PATH, request, timeoutMs);
}

export async function tryIoregCandidates(conn: Client, ioregClass: string, candidates: string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${ioregClass} -w 0 2>&1`);
    if (code === 0 && stdout.includes(ioregClass)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}
