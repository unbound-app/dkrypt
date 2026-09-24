import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { resolveOauthAccount } from '#account.js';
import { getAuthProfile } from '#identity.js';
import { buildAccountExport, deleteAccount } from '#privacy.js';
import { addAllowedUser, createApiKey, createSessionRecord, listAllowedUsers } from '#store/state.js';

describe('account privacy workflows', () => {
  test('exports only the requesting account data and never includes session IPs or key secrets', () => {
    const userId = `github:privacy-${randomUUID()}`;
    resolveOauthAccount({
      fallbackUserId: userId,
      identity: {
        provider: 'github',
        providerId: randomUUID(),
        username: userId,
        displayName: 'Privacy Test',
        source: 'oauth',
        updatedAt: new Date().toISOString(),
      },
    });
    addAllowedUser(userId, [], 'tester');
    createApiKey('private key', userId);
    createSessionRecord(userId, 'test-agent', '192.0.2.1');

    const payload = buildAccountExport(userId);

    expect(payload.account.userId).toBe(userId);
    expect(payload.sessions[0]).not.toHaveProperty('ip');
    expect(payload.apiKeys[0]).not.toHaveProperty('key');
  });

  test('deletes personal account data after explicit provider cleanup', () => {
    const userId = `github:delete-${randomUUID()}`;
    resolveOauthAccount({
      fallbackUserId: userId,
      identity: {
        provider: 'github',
        providerId: randomUUID(),
        username: userId,
        displayName: 'Delete Test',
        source: 'oauth',
        updatedAt: new Date().toISOString(),
      },
    });
    addAllowedUser(userId, [], 'tester');

    expect(deleteAccount(userId)).toEqual({ ok: true });
    expect(listAllowedUsers().some((user) => user.username === userId)).toBe(false);
    expect(getAuthProfile(userId)).toBeUndefined();
  });
});
