import { describe, expect, test } from 'bun:test';
import { verifyTotp } from '#mfa.js';

describe('multi-factor authentication', () => {
  test('accepts RFC 6238-compatible six digit codes with a one-step clock window', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(verifyTotp(secret, '287082', 59_000)).toBe(true);
    expect(verifyTotp(secret, '287082', 90_000)).toBe(false);
    expect(verifyTotp(secret, '000000', 59_000)).toBe(false);
  });
});
