import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'ssh2';
import { scopedLogger } from '#logger.js';

const log = scopedLogger('idevice');

const REQUEST_PATH = '/tmp/autoinstall-request.json';
const RESPONSE_PATH = '/tmp/autoinstall-response.json';
const SB_REQUEST_PATH = '/tmp/autoinstall-sb-request.json';
const SB_RESPONSE_PATH = '/tmp/autoinstall-sb-response.json';
const AS_REQUEST_PATH = '/tmp/autoinstall-as-request.json';
const AS_RESPONSE_PATH = '/tmp/autoinstall-as-response.json';
const AUTOCONFIRM_FLAG_PATH = '/tmp/autoinstall-autoconfirm.flag';

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
      return await fn(conn);
    } catch (err) {
      authCache.delete(rootDir);
      throw err;
    } finally {
      conn.end();
    }
  });
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
  if (!appPath.endsWith('.app') || !appPath.includes('/var/containers/Bundle/Application/')) return false;

  const container = appPath.replace(/\/[^/]+\.app$/, '');
  if (!/\/var\/containers\/Bundle\/Application\/[^/]+$/.test(container)) return false;

  await execCommand(conn, `sudo /var/jb/usr/bin/uicache -u "${appPath}" 2>/dev/null; sudo rm -rf "${container}"`);
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

const withBridgeLock = makeSerialQueue();

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
        if (parsed.ok === false) throw new Error(`autoinstall bridge error: ${parsed.error}`);
        return parsed;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`autoinstall bridge request timed out: ${JSON.stringify(request)}`);
  });
}

export function sendTestFlightBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, REQUEST_PATH, RESPONSE_PATH, request, timeoutMs);
}

export function sendSpringBoardBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, SB_REQUEST_PATH, SB_RESPONSE_PATH, request, timeoutMs);
}

export function sendAppStoreBridgeRequest(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  return sendBridgeRequestRawTo(conn, AS_REQUEST_PATH, AS_RESPONSE_PATH, request, timeoutMs);
}

export async function tryIoregCandidates(conn: Client, ioregClass: string, candidates: string[]): Promise<string | undefined> {
  for (const bin of candidates) {
    const { stdout, stderr, code } = await execCommand(conn, `${bin} -rc ${ioregClass} -w 0 2>&1`);
    if (code === 0 && stdout.includes(ioregClass)) return stdout;
    log.warn('ioreg candidate did not produce battery data', { bin, code, output: (stdout || stderr).slice(0, 200) });
  }
  return undefined;
}
