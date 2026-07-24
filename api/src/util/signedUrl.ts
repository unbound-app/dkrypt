import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '#config.js';

export function signDownloadToken(jobId: string, expiresAtMs: number): string {
  const payload = `${jobId}.${expiresAtMs}`;
  const sig = createHmac('sha256', config.downloadSigningSecret).update(payload).digest('hex');
  return `${expiresAtMs}.${sig}`;
}

export function verifyTokenSignature(jobId: string, token: string): number | undefined {
  const [expiresAtStr, sig] = token.split('.');
  if (!expiresAtStr || !sig) return undefined;

  const expiresAtMs = Number.parseInt(expiresAtStr, 10);
  if (Number.isNaN(expiresAtMs)) return undefined;

  const expected = createHmac('sha256', config.downloadSigningSecret)
    .update(`${jobId}.${expiresAtMs}`)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return undefined;
  return timingSafeEqual(a, b) ? expiresAtMs : undefined;
}

export function verifyDownloadToken(jobId: string, token: string): boolean {
  const expiresAtMs = verifyTokenSignature(jobId, token);
  return expiresAtMs !== undefined && Date.now() <= expiresAtMs;
}

export function buildSignedFileUrl(jobId: string, ttlMinutes: number): string {
  const expiresAtMs = Date.now() + ttlMinutes * 60_000;
  const token = signDownloadToken(jobId, expiresAtMs);
  return `${config.publicBaseUrl}/v1/jobs/${jobId}/file?token=${token}`;
}

export function buildSignedFileUrlWithToken(jobId: string, ttlMinutes: number): { url: string; token: string; expiresAtMs: number } {
  const expiresAtMs = Date.now() + ttlMinutes * 60_000;
  const token = signDownloadToken(jobId, expiresAtMs);
  return { url: `${config.publicBaseUrl}/v1/jobs/${jobId}/file?token=${token}`, token, expiresAtMs };
}
