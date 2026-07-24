import { describe, expect, test } from 'bun:test';
import { buildSignedFileUrl, signDownloadToken, verifyDownloadToken } from '#util/signedUrl.js';

describe('signDownloadToken / verifyDownloadToken', () => {
  test('a freshly signed token verifies for its own job', () => {
    const token = signDownloadToken('job-1', Date.now() + 60_000);
    expect(verifyDownloadToken('job-1', token)).toBe(true);
  });

  test('rejects a token replayed against a different job', () => {
    const token = signDownloadToken('job-1', Date.now() + 60_000);
    expect(verifyDownloadToken('job-2', token)).toBe(false);
  });

  test('rejects an expired token', () => {
    const token = signDownloadToken('job-1', Date.now() - 1000);
    expect(verifyDownloadToken('job-1', token)).toBe(false);
  });

  test('rejects a same-length but tampered signature', () => {
    const token = signDownloadToken('job-1', Date.now() + 60_000);
    const [expiresAtStr, sig] = token.split('.');
    const tamperedSig = sig!.startsWith('0') ? `1${sig!.slice(1)}` : `0${sig!.slice(1)}`;
    expect(verifyDownloadToken('job-1', `${expiresAtStr}.${tamperedSig}`)).toBe(false);
  });

  test('rejects a malformed token', () => {
    expect(verifyDownloadToken('job-1', 'not-a-real-token')).toBe(false);
  });
});

describe('buildSignedFileUrl', () => {
  test('embeds a token that verifies for the same job', () => {
    const url = buildSignedFileUrl('job-1', 15);
    const token = new URL(url).searchParams.get('token');
    expect(token).toBeTruthy();
    expect(verifyDownloadToken('job-1', token!)).toBe(true);
  });
});
