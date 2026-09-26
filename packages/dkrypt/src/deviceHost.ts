import { isIP } from 'node:net';

export function isSupportedDeviceHost(host: string): boolean {
  if (!host || host.length > 253 || host.trim() !== host) return false;
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isIP(host) === 4;
  return isIP(host) === 6 || /^[A-Za-z0-9._-]{1,253}$/.test(host);
}
