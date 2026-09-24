import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { config } from '#config.js';
import { addPasskey, deletePasskey, getPasskeyById, listPasskeysForUser, updatePasskey, type PasskeyCredential } from '#store/state.js';

type ChallengeKind = 'authentication' | 'registration';

interface ChallengeRecord {
  kind: ChallengeKind;
  userId?: string;
  expiresAt: number;
}

const challenges = new Map<string, ChallengeRecord>();
const CHALLENGE_TTL_MS = 5 * 60_000;

function relyingParty(): { origin: string; id: string } {
  const url = new URL(config.publicBaseUrl);
  return { origin: url.origin, id: url.hostname };
}

function normalizedUserId(userId: string): string {
  return userId === 'root' ? 'root' : userId.toLowerCase();
}

function rememberChallenge(challenge: string, record: Omit<ChallengeRecord, 'expiresAt'>): void {
  challenges.set(challenge, { ...record, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

function consumeChallenge(challenge: string, kind: ChallengeKind, userId?: string): boolean {
  const record = challenges.get(challenge);
  challenges.delete(challenge);
  if (!record || record.kind !== kind || record.expiresAt < Date.now()) return false;
  if (userId !== undefined && record.userId !== normalizedUserId(userId)) return false;
  return true;
}

function cleanupChallenges(): void {
  const now = Date.now();
  for (const [challenge, record] of challenges) if (record.expiresAt < now) challenges.delete(challenge);
}

setInterval(cleanupChallenges, 60_000).unref();

export async function beginPasskeyRegistration(userId: string): Promise<Record<string, unknown>> {
  const normalized = normalizedUserId(userId);
  const { id } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: 'dkrypt',
    rpID: id,
    userName: normalized,
    userID: Buffer.from(normalized, 'utf8'),
    userDisplayName: normalized,
    attestationType: 'none',
    excludeCredentials: listPasskeysForUser(normalized).map((credential) => ({ id: credential.id, transports: credential.transports })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  rememberChallenge(options.challenge, { kind: 'registration', userId: normalized });
  return { ...options } as Record<string, unknown>;
}

export async function finishPasskeyRegistration(userId: string, response: RegistrationResponseJSON, name?: string): Promise<PasskeyCredential> {
  const normalized = normalizedUserId(userId);
  const { origin, id } = relyingParty();
  const result = await verifyRegistrationResponse({
    response,
    expectedChallenge: (challenge) => consumeChallenge(challenge, 'registration', normalized),
    expectedOrigin: origin,
    expectedRPID: id,
  });
  if (!result.verified || !result.registrationInfo) throw new Error('passkey registration could not be verified');
  const credential = result.registrationInfo.credential;
  return addPasskey({
    id: credential.id,
    userId: normalized,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    transports: response.response.transports,
    name: name?.trim().slice(0, 80) || undefined,
    createdAt: Date.now(),
  });
}

export async function beginPasskeyAuthentication(): Promise<Record<string, unknown>> {
  const { id } = relyingParty();
  const options = await generateAuthenticationOptions({
    rpID: id,
    userVerification: 'preferred',
  });
  rememberChallenge(options.challenge, { kind: 'authentication' });
  return { ...options } as Record<string, unknown>;
}

export async function finishPasskeyAuthentication(response: AuthenticationResponseJSON): Promise<{ userId: string; credential: PasskeyCredential }> {
  const stored = getPasskeyById(response.id);
  if (!stored) throw new Error('passkey is not registered');
  const { origin, id } = relyingParty();
  const result = await verifyAuthenticationResponse({
    response,
    expectedChallenge: (challenge) => consumeChallenge(challenge, 'authentication'),
    expectedOrigin: origin,
    expectedRPID: id,
    credential: {
      id: stored.id,
      publicKey: Buffer.from(stored.publicKey, 'base64url'),
      counter: stored.counter,
      transports: stored.transports,
    },
  });
  if (!result.verified) throw new Error('passkey authentication could not be verified');
  const credential = updatePasskey(stored.id, { counter: result.authenticationInfo.newCounter, lastUsedAt: Date.now() });
  if (!credential) throw new Error('passkey record disappeared during authentication');
  return { userId: stored.userId, credential };
}

export function listUserPasskeys(userId: string): Array<Omit<PasskeyCredential, 'publicKey'>> {
  return listPasskeysForUser(userId).map(({ publicKey: _publicKey, ...credential }) => credential);
}

export function removeUserPasskey(userId: string, id: string): boolean {
  return deletePasskey(userId, id);
}

export function clearPasskeyChallenges(): void {
  challenges.clear();
}
