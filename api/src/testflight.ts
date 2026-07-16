import { readFile } from 'node:fs/promises';
import { Client } from 'ssh2';
import { config } from './config.js';
import { scopedLogger } from './logger.js';

const log = scopedLogger('testflight');

const REQUEST_PATH = '/tmp/tfauto-request.json';
const RESPONSE_PATH = '/tmp/tfauto-response.json';

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

let cachedAuth: DeviceAuth | undefined;

async function loadDeviceAuth(): Promise<DeviceAuth> {
  if (cachedAuth) return cachedAuth;
  const raw = JSON.parse(await readFile(config.ipadecryptConfigPath, 'utf8')) as RawIpadecryptConfig;
  const device = raw.device;
  if (!device?.host || !device.port || !device.user || !device.auth?.keyPath) {
    throw new Error('ipadecrypt config is missing device connection info (host/port/user/auth.keyPath)');
  }
  cachedAuth = { host: device.host, port: device.port, user: device.user, keyPath: device.auth.keyPath };
  return cachedAuth;
}

async function withSSH<T>(fn: (conn: Client) => Promise<T>): Promise<T> {
  const auth = await loadDeviceAuth();
  const privateKey = await readFile(auth.keyPath);
  const conn = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      conn.on('ready', () => resolve());
      conn.on('error', reject);
      conn.connect({ host: auth.host, port: auth.port, username: auth.user, privateKey, readyTimeout: 15_000 });
    });
    return await fn(conn);
  } finally {
    conn.end();
  }
}

function execCommand(conn: Client, command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
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

async function readRemoteFileIfExists(conn: Client, remotePath: string): Promise<string | undefined> {
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

async function isTestFlightRunning(conn: Client): Promise<boolean> {
  const { stdout } = await execCommand(conn, "ps aux | grep -i '/TestFlight$' | grep -v grep");
  return stdout.trim().length > 0;
}

async function launchTestFlight(conn: Client): Promise<void> {
  await execCommand(conn, 'uiopen --bundleid com.apple.TestFlight');
}

async function waitForBridgeReady(conn: Client, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await sendBridgeRequestRaw(conn, { action: 'status' }, 3_000);
      if (response?.hasInstaller && response?.hasCatalogManager) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error('tfauto bridge did not become ready within timeout');
}

export async function ensureTestFlightRunning(): Promise<void> {
  await withSSH(async (conn) => {
    if (await isTestFlightRunning(conn)) {
      log.info('TestFlight already running');
      return;
    }
    log.info('launching TestFlight autonomously via uiopen');
    await launchTestFlight(conn);
    await new Promise((r) => setTimeout(r, 3_000));
    await waitForBridgeReady(conn);
  });
}

async function sendBridgeRequestRaw(conn: Client, request: Record<string, unknown>, timeoutMs = 20_000): Promise<any> {
  await execCommand(conn, `rm -f ${RESPONSE_PATH}`);
  await writeRemoteFile(conn, REQUEST_PATH, JSON.stringify(request));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await readRemoteFileIfExists(conn, RESPONSE_PATH);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.ok === false) throw new Error(`tfauto bridge error: ${parsed.error}`);
      return parsed;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`tfauto bridge request timed out: ${JSON.stringify(request)}`);
}

export interface TFTrain {
  trainVersion: string;
  buildCount: number;
}

export interface TFBuild {
  id: number;
  cfBundleShortVersion: string;
  cfBundleVersion: string;
  bundleId: string;
  whatsNew?: string;
  releaseDate?: string;
  expiration?: string;
  fileSize?: number;
  [key: string]: unknown;
}

export async function listTrains(appId: number): Promise<TFTrain[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendBridgeRequestRaw(conn, { action: 'list_trains', appId });
    return response.data as TFTrain[];
  });
}

export async function listBuilds(appId: number, trainVersion: string): Promise<TFBuild[]> {
  await ensureTestFlightRunning();
  return withSSH(async (conn) => {
    const response = await sendBridgeRequestRaw(conn, { action: 'list_builds', appId, trainVersion });
    return response.data as TFBuild[];
  });
}

async function findInstalledBundlePath(conn: Client, bundleId: string): Promise<string | undefined> {
  const { stdout } = await execCommand(
    conn,
    `find /var/containers/Bundle/Application -maxdepth 1 -exec sh -c "grep -la ${bundleId} {}/*.app/Info.plist 2>/dev/null" \\; 2>/dev/null`,
  );
  const line = stdout.trim().split('\n')[0];
  return line || undefined;
}

async function readInstalledBundleVersion(conn: Client, infoPlistPath: string): Promise<string | undefined> {
  const tmp = `/tmp/dkrypt-check-${Date.now()}.plist`;
  await execCommand(conn, `cp "${infoPlistPath}" ${tmp} && chmod 644 ${tmp} && /cores/binpack/usr/bin/plutil -convert xml1 ${tmp}`);
  const { stdout } = await execCommand(conn, `cat ${tmp}`);
  await execCommand(conn, `rm -f ${tmp}`);
  const match = stdout.match(/<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/);
  return match?.[1];
}

const SAFE_BUNDLE_ID_RE = /^[A-Za-z0-9.-]{1,200}$/;

export async function installBuild(appId: number, build: TFBuild, waitTimeoutMs = 5 * 60_000): Promise<void> {
  if (!SAFE_BUNDLE_ID_RE.test(build.bundleId)) {
    throw new Error(`refusing to install build with unsafe bundleId: ${JSON.stringify(build.bundleId)}`);
  }
  await ensureTestFlightRunning();
  await withSSH(async (conn) => {
    await sendBridgeRequestRaw(conn, { action: 'install', appId, build });

    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      const bundlePath = await findInstalledBundlePath(conn, build.bundleId);
      if (bundlePath) {
        const version = await readInstalledBundleVersion(conn, bundlePath);
        if (version === build.cfBundleVersion) {
          log.info('TestFlight build installed', { bundleId: build.bundleId, version });
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 5_000));
    }
    throw new Error(`timed out waiting for ${build.bundleId} to reach build ${build.cfBundleVersion}`);
  });
}
