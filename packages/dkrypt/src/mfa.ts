import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '#config.js';
import { getUserMfa, setUserMfa, type UserMfaRecord } from '#store/state.js';

const ISSUER = 'dkrypt';
const STEP_SECONDS = 30;
const CODE_LENGTH = 6;

function encryptionKeys(): Buffer[] {
  return [config.sessionSigningSecret, config.sessionSigningSecretPrevious].filter(Boolean).map((secret) => createHash('sha256').update(`${secret}:mfa`).digest());
}

function encrypt(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKeys()[0], iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decrypt(value: string): string | undefined {
  try {
    const [ivValue, tagValue, encryptedValue] = value.split('.');
    if (!ivValue || !tagValue || !encryptedValue) return undefined;
    const iv = Buffer.from(ivValue, 'base64url');
    const tag = Buffer.from(tagValue, 'base64url');
    const encrypted = Buffer.from(encryptedValue, 'base64url');
    for (const key of encryptionKeys()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function base32Encode(value: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(buffer << (5 - bits)) & 31];
  return output;
}

function base32Decode(value: string): Buffer | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];
  for (const char of value.replaceAll('=', '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) return undefined;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function totp(secret: string, timestampMs = Date.now()): string | undefined {
  const key = base32Decode(secret);
  if (!key || key.length < 10) return undefined;
  const counter = Math.floor(timestampMs / 1000 / STEP_SECONDS);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(value % 10 ** CODE_LENGTH).padStart(CODE_LENGTH, '0');
}

function safeCodeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function recoveryHashes(value: string): string[] {
  return [config.sessionSigningSecret, config.sessionSigningSecretPrevious]
    .filter(Boolean)
    .map((secret) => createHmac('sha256', secret).update(`recovery:${value.toUpperCase()}`).digest('hex'));
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(5).toString('hex').toUpperCase());
}

function recordFor(userId: string): UserMfaRecord {
  return getUserMfa(userId) ?? { enabled: false };
}

export function mfaStatus(userId: string): { enabled: boolean; recoveryCodesRemaining: number } {
  const record = recordFor(userId);
  return { enabled: record.enabled, recoveryCodesRemaining: record.recoveryCodeHashes?.length ?? 0 };
}

export function beginMfaEnrollment(userId: string): { secret: string; otpauthUrl: string } {
  const secret = base32Encode(randomBytes(20));
  const record = recordFor(userId);
  setUserMfa(userId, { ...record, pendingSecretCiphertext: encrypt(secret), updatedAt: Date.now() });
  const label = encodeURIComponent(`${ISSUER}:${userId}`);
  const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${CODE_LENGTH}&period=${STEP_SECONDS}`;
  return { secret, otpauthUrl };
}

export function confirmMfaEnrollment(userId: string, token: string): { recoveryCodes: string[] } | undefined {
  const record = recordFor(userId);
  const secret = record.pendingSecretCiphertext ? decrypt(record.pendingSecretCiphertext) : undefined;
  if (!secret || !verifyTotp(secret, token)) return undefined;
  const recoveryCodes = generateRecoveryCodes();
  setUserMfa(userId, {
    enabled: true,
    secretCiphertext: encrypt(secret),
    recoveryCodeHashes: recoveryCodes.map((code) => recoveryHashes(code)[0]),
    updatedAt: Date.now(),
  });
  return { recoveryCodes };
}

export function verifyTotp(secret: string, token: string, timestampMs = Date.now()): boolean {
  const normalized = token.replaceAll(' ', '');
  if (!/^\d{6}$/.test(normalized)) return false;
  for (const offset of [-STEP_SECONDS * 1000, 0, STEP_SECONDS * 1000]) {
    const expected = totp(secret, timestampMs + offset);
    if (expected && safeCodeEqual(expected, normalized)) return true;
  }
  return false;
}

export function verifyMfa(userId: string, token: string): { ok: boolean; recoveryUsed: boolean } {
  const record = recordFor(userId);
  if (!record.enabled) return { ok: true, recoveryUsed: false };
  const secret = record.secretCiphertext ? decrypt(record.secretCiphertext) : undefined;
  if (secret && verifyTotp(secret, token)) return { ok: true, recoveryUsed: false };
  const hashes = recoveryHashes(token.trim());
  const index = record.recoveryCodeHashes?.findIndex((value) => hashes.some((hash) => safeCodeEqual(value, hash))) ?? -1;
  if (index < 0) return { ok: false, recoveryUsed: false };
  const recoveryCodeHashes = [...(record.recoveryCodeHashes ?? [])];
  recoveryCodeHashes.splice(index, 1);
  setUserMfa(userId, { ...record, recoveryCodeHashes, updatedAt: Date.now() });
  return { ok: true, recoveryUsed: true };
}

export function disableMfa(userId: string, token: string): boolean {
  const status = mfaStatus(userId);
  if (!status.enabled || !verifyMfa(userId, token).ok) return false;
  return setUserMfa(userId, undefined);
}

export function regenerateRecoveryCodes(userId: string, token: string): string[] | undefined {
  const record = recordFor(userId);
  if (!record.enabled || !verifyMfa(userId, token).ok) return undefined;
  const recoveryCodes = generateRecoveryCodes();
  setUserMfa(userId, { ...record, recoveryCodeHashes: recoveryCodes.map((code) => recoveryHashes(code)[0]), updatedAt: Date.now() });
  return recoveryCodes;
}
