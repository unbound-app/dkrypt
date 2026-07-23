import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { resolveOauthAccount } from './account.js';
import {
  getBillingCustomerId,
  getBillingEntitlements,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from './billing.js';
import {
  type AuthIdentity,
  getLinkedAuthProviders,
  setAuthDisplayName,
} from './identity.js';
import { PermissionFlag, serializeBits } from './permissions.js';
import {
  addAllowedUser,
  createApiKey,
  createRole,
  listAllowedUsers,
  listApiKeysForOwner,
} from './store/state.js';

function identity(
  provider: 'github' | 'discord',
  providerId: string,
  source: 'oauth' | 'discord_connection' = 'oauth',
): AuthIdentity {
  const username = `${provider}-${providerId}`;
  return {
    provider,
    providerId,
    username,
    displayName: username,
    source,
    updatedAt: new Date().toISOString(),
  };
}

describe('resolveOauthAccount', () => {
  test('merges a Discord GitHub connection into a legacy GitHub account immediately', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const connectedGithubIdentity = identity('github', githubId, 'discord_connection');
    const legacyGithubUserId = connectedGithubIdentity.username.toLowerCase();
    const role = createRole(
      {
        name: `Connected legacy role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(legacyGithubUserId, [role.id], 'tester');
    createApiKey('connected legacy key', legacyGithubUserId);

    const merged = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [connectedGithubIdentity],
    });

    expect(merged.userId).toBe(legacyGithubUserId);
    expect(getLinkedAuthProviders(legacyGithubUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().some((user) => user.username === discordUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === legacyGithubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(legacyGithubUserId)).toHaveLength(1);
  });

  test('merges a linked OAuth profile into a legacy GitHub account', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const legacyGithubUserId = `legacy-${randomUUID()}`;

    resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });
    const role = createRole(
      {
        name: `Legacy role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(legacyGithubUserId, [role.id], 'tester');
    createApiKey('legacy key', legacyGithubUserId);

    const merged = resolveOauthAccount({
      fallbackUserId: legacyGithubUserId,
      identity: identity('github', githubId),
    });

    expect(merged.userId).toBe(legacyGithubUserId);
    expect(getLinkedAuthProviders(legacyGithubUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().some((user) => user.username === discordUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === legacyGithubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(legacyGithubUserId)).toHaveLength(1);
  });

  test('links a later GitHub login to a Discord-first account', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;

    const discordProfile = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });
    const githubProfile = resolveOauthAccount({
      fallbackUserId: `github:${githubId}`,
      identity: identity('github', githubId),
    });

    expect(discordProfile.userId).toBe(discordUserId);
    expect(githubProfile.userId).toBe(discordUserId);
    expect(getLinkedAuthProviders(discordUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().filter((user) => user.username === discordUserId)).toHaveLength(0);
  });

  test('merges independently used Discord and GitHub accounts', () => {
    const discordId = randomUUID();
    const githubId = randomUUID();
    const discordUserId = `discord:${discordId}`;
    const githubUserId = `github:${githubId}`;

    resolveOauthAccount({
      fallbackUserId: githubUserId,
      identity: identity('github', githubId),
    });
    setAuthDisplayName(githubUserId, 'Chosen profile name');

    resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
    });
    const role = createRole(
      {
        name: `Merged role ${randomUUID()}`,
        color: '#5865f2',
        permissions: serializeBits(PermissionFlag.viewLogs),
      },
      'tester',
    );
    addAllowedUser(discordUserId, [role.id], 'tester');
    createApiKey('merged key', discordUserId);
    upsertBillingCustomer({
      customerId: `ctm_${randomUUID()}`,
      email: 'linked@example.com',
      userId: discordUserId,
      updatedAt: new Date().toISOString(),
    });
    upsertBillingSubscription({
      subscriptionId: `sub_${randomUUID()}`,
      customerId: getBillingCustomerId(discordUserId) ?? '',
      userId: discordUserId,
      status: 'active',
      planId: 'priority_api',
      priceId: `pri_${randomUUID()}`,
      productId: `pro_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const merged = resolveOauthAccount({
      fallbackUserId: discordUserId,
      identity: identity('discord', discordId),
      discoveredIdentities: [identity('github', githubId, 'discord_connection')],
    });

    expect(merged.userId).toBe(githubUserId);
    expect(merged.displayName).toBe('Chosen profile name');
    expect(getLinkedAuthProviders(githubUserId).sort()).toEqual(['discord', 'github']);
    expect(listAllowedUsers().some((user) => user.username === discordUserId)).toBe(false);
    expect(listAllowedUsers().find((user) => user.username === githubUserId)?.roleIds).toContain(role.id);
    expect(listApiKeysForOwner(githubUserId)).toHaveLength(1);
    expect(getBillingCustomerId(githubUserId)).toBeDefined();
    expect(getBillingEntitlements(githubUserId).planId).toBe('priority_api');
  });

  test('keeps a custom profile name through later OAuth refreshes', () => {
    const githubId = randomUUID();
    const userId = `github:${githubId}`;

    resolveOauthAccount({
      fallbackUserId: userId,
      identity: identity('github', githubId),
    });
    setAuthDisplayName(userId, 'Custom name');
    const refreshed = resolveOauthAccount({
      fallbackUserId: userId,
      identity: {
        ...identity('github', githubId),
        displayName: 'Changed provider name',
      },
    });

    expect(refreshed.displayName).toBe('Custom name');
  });
});
