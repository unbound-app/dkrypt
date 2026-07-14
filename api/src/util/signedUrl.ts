import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/**
 * Short-lived, job-scoped download tokens let the GitHub Actions runner
 * fetch a decrypted IPA without holding the master API_KEY. Signature
 * covers jobId + expiry so a token can't be replayed for another job or
 * past its TTL.
 */
export function signDownloadToken(jobId: string, expiresAtMs: number): string {
  const payload = `${jobId}.${expiresAtMs}`;
  const sig = createHmac('sha256', config.downloadSigningSecret).update(payload).digest('hex');
  return `${expiresAtMs}.${sig}`;
}

export function verifyDownloadToken(jobId: string, token: string): boolean {
  const [expiresAtStr, sig] = token.split('.');
  if (!expiresAtStr || !sig) return false;

  const expiresAtMs = Number.parseInt(expiresAtStr, 10);
  if (Number.isNaN(expiresAtMs) || Date.now() > expiresAtMs) return false;

  const expected = createHmac('sha256', config.downloadSigningSecret)
    .update(`${jobId}.${expiresAtMs}`)
    .digest('hex');

  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function buildSignedFileUrl(jobId: string, ttlMinutes: number): string {
  const expiresAtMs = Date.now() + ttlMinutes * 60_000;
  const token = signDownloadToken(jobId, expiresAtMs);
  return `${config.publicBaseUrl}/v1/jobs/${jobId}/file?token=${token}`;
}
