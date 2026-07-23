import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  getBillingCustomerId,
  replaceBillingSnapshot,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from '../billing.js';
import { getAuthProfile, replaceIdentitySnapshot, upsertAuthProfile } from '../identity.js';
import { PermissionFlag, serializeBits } from '../permissions.js';
import {
  addAllowedUser,
  createApiKey,
  createDevice,
  createDiscordRolePerk,
  createRole,
  createWatch,
  deleteDevice,
  deleteWatch,
  exportBackup,
  getAllJobHistory,
  getDeviceHealthHourlyBuckets,
  getDeviceUptimePercent,
  getDiscordGuildIds,
  getDiscordRolePerks,
  getEffectiveDevices,
  getWatchConfigIssues,
  getWebhookDeliveryLog,
  importBackup,
  listAllowedUsers,
  recordDeviceHealthCheck,
  recordJobHistory,
  recordWebhookDelivery,
  setDiscordGuildIds,
  syncDiscordPerkRoles,
  updateAllowedUserRoles,
  updateDevice,
  updateSettings,
  updateWatch,
  verifyApiKey,
} from './state.js';

describe('Discord role perks', () => {
  test('syncs guild-scoped perks from multiple guilds', () => {
    const userId = `discord:${randomUUID()}`;
    const firstGuildId = randomUUID();
    const secondGuildId = randomUUID();
    const firstDiscordRoleId = randomUUID();
    const secondDiscordRoleId = randomUUID();
    const firstAppRole = createRole({ name: `First perk ${randomUUID()}`, color: '#5865f2', permissions: '0' }, 'tester');
    const secondAppRole = createRole({ name: `Second perk ${randomUUID()}`, color: '#57f287', permissions: '0' }, 'tester');

    addAllowedUser(userId, [], 'tester');
    setDiscordGuildIds([firstGuildId, secondGuildId], 'tester');
    createDiscordRolePerk(
      { id: firstGuildId, name: 'First guild', icon: 'first-icon' },
      { id: firstDiscordRoleId, name: 'First Discord role', color: 0x5865f2 },
      firstAppRole.id,
      'tester',
    );
    createDiscordRolePerk(
      { id: secondGuildId, name: 'Second guild', icon: null },
      { id: secondDiscordRoleId, name: 'Second Discord role', color: 0x57f287 },
      secondAppRole.id,
      'tester',
    );

    expect(getDiscordGuildIds()).toEqual([firstGuildId, secondGuildId]);
    expect(getDiscordRolePerks()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ guildId: firstGuildId, guildName: 'First guild', guildIcon: 'first-icon', discordRoleColor: 0x5865f2 }),
        expect.objectContaining({ guildId: secondGuildId, guildName: 'Second guild', guildIcon: null, discordRoleColor: 0x57f287 }),
      ]),
    );

    syncDiscordPerkRoles(userId, [
      { guildId: firstGuildId, roleIds: [firstDiscordRoleId] },
      { guildId: secondGuildId, roleIds: [] },
    ]);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).toContain(firstAppRole.id);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).not.toContain(secondAppRole.id);

    syncDiscordPerkRoles(userId, [
      { guildId: firstGuildId, roleIds: [] },
      { guildId: secondGuildId, roleIds: [secondDiscordRoleId] },
    ]);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).not.toContain(firstAppRole.id);
    expect(listAllowedUsers().find((user) => user.username === userId)?.roleIds).toContain(secondAppRole.id);
  });
});

describe('exportBackup / importBackup', () => {
  test('round-trips the allowlist through export and import', () => {
    const role = createRole({ name: 'Roundtrip Role', color: '#5865f2', permissions: serializeBits(PermissionFlag.requestDecrypt) }, 'tester');
    addAllowedUser('roundtrip-user', [role.id], 'tester');
    const backup = exportBackup();

    expect(backup.backupVersion).toBe(4);
    expect(backup.allowedUsers.some((u) => u.username === 'roundtrip-user')).toBe(true);

    const result = importBackup(backup, 'tester');
    expect(result.ok).toBe(true);
    expect(listAllowedUsers().some((u) => u.username === 'roundtrip-user')).toBe(true);
  });

  test('rejects a backup with the wrong version', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, backupVersion: 99 }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/version/);
  });

  test('rejects a backup with a malformed allowedUsers entry', () => {
    const backup = exportBackup();
    const result = importBackup({ ...backup, allowedUsers: [{ username: 'bad' }] }, 'tester');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/allowedUsers/);
  });

  test('rejects a non-object payload', () => {
    expect(importBackup(null, 'tester').ok).toBe(false);
    expect(importBackup('not json', 'tester').ok).toBe(false);
  });

  test('strips any plaintext pendingReveal from imported API keys', () => {
    const backup = exportBackup();
    const tampered = {
      ...backup,
      apiKeys: [
        {
          id: 'k1',
          name: 'sneaky',
          ownerId: 'root',
          status: 'approved' as const,
          createdAt: Date.now(),
          pendingReveal: 'should-not-survive-import',
        },
      ],
    };
    const result = importBackup(tampered, 'tester');
    expect(result.ok).toBe(true);
    const reExported = exportBackup();
    const key = reExported.apiKeys.find((k) => k.id === 'k1');
    expect(key?.pendingReveal).toBeUndefined();
  });

  test('round-trips OAuth profiles and Paddle subscriptions', () => {
    const userId = `github:${randomUUID()}`;
    upsertAuthProfile({
      userId,
      provider: 'github',
      providerId: randomUUID(),
      username: 'billing-user',
      displayName: 'Billing User',
      email: 'billing@example.com',
      updatedAt: new Date().toISOString(),
    });
    upsertBillingCustomer({
      customerId: 'ctm_backup',
      email: 'billing@example.com',
      userId,
      updatedAt: new Date().toISOString(),
    });
    upsertBillingSubscription({
      subscriptionId: 'sub_backup',
      customerId: 'ctm_backup',
      userId,
      status: 'active',
      planId: 'api',
      priceId: 'pri_backup',
      productId: 'pro_backup',
      occurredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const backup = exportBackup();

    replaceIdentitySnapshot({ profiles: [] });
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    expect(importBackup(backup, 'tester').ok).toBe(true);

    expect(getAuthProfile(userId)?.email).toBe('billing@example.com');
    expect(getBillingCustomerId(userId)).toBe('ctm_backup');
  });
});

describe('API subscription entitlement', () => {
  test('rejects a stored user key until the owner has API permission', () => {
    const username = `api-viewer-${randomUUID()}`;
    addAllowedUser(username, [], 'tester');
    const created = createApiKey('subscription-gated', username);

    expect(verifyApiKey(created.key)).toBeUndefined();

    const role = createRole({
      name: `API ${randomUUID()}`,
      color: '#5865f2',
      permissions: serializeBits(PermissionFlag.createApiKeys),
    }, 'tester');
    updateAllowedUserRoles(username, [role.id], 'tester');

    expect(verifyApiKey(created.key)).toMatchObject({ ownerId: username });
  });
});

describe('getWatchConfigIssues', () => {
  test('reports nothing for a fully unconfigured watch', () => {
    expect(getWatchConfigIssues({ id: 'x', bundleId: '', repo: '', ghWorkflowFile: '', pollCron: '', enabled: true, createdAt: 0, updatedAt: 0 })).toEqual([]);
  });

  test('flags a partially-filled watch as a likely mistake', () => {
    const { watch } = createWatch({ bundleId: 'com.example.app', repo: '', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    const issues = getWatchConfigIssues(watch!);
    expect(issues.length).toBe(1);
    expect(issues[0]).toMatch(/partially configured/);
    expect(issues[0]).toMatch(/repo/);
  });

  test('flags a missing GH_TOKEN once the repo is set', () => {
    // test/setup.ts never sets GH_TOKEN, so config.ghToken is '' here.
    const { watch } = createWatch({ bundleId: 'com.example.app2', repo: 'me/app', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    const issues = getWatchConfigIssues(watch!);
    expect(issues.some((i) => i.includes('GH_TOKEN'))).toBe(true);
  });
});

describe('watch CRUD', () => {
  test('rejects a second enabled watch targeting the same bundle ID', () => {
    const first = createWatch({ bundleId: 'com.example.collide', repo: 'me/app', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    expect(first.ok).toBe(true);

    const second = createWatch({ bundleId: 'com.example.collide', repo: 'me/app2', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/already targets/);

    // A disabled watch on the same bundle ID is fine - only *enabled* watches can't collide.
    const disabled = createWatch(
      { bundleId: 'com.example.collide', repo: 'me/app3', ghWorkflowFile: '', pollCron: '0 * * * *', enabled: false },
      'tester',
    );
    expect(disabled.ok).toBe(true);

    deleteWatch(first.watch!.id, 'tester');
    deleteWatch(disabled.watch!.id, 'tester');
  });

  test('updateWatch still enforces the collision rule against other enabled watches', () => {
    const a = createWatch({ bundleId: 'com.example.a', repo: '', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    const b = createWatch({ bundleId: 'com.example.b', repo: '', ghWorkflowFile: '', pollCron: '0 * * * *' }, 'tester');
    expect(a.ok && b.ok).toBe(true);

    const result = updateWatch(b.watch!.id, { bundleId: 'com.example.a' }, 'tester');
    expect(result.ok).toBe(false);

    deleteWatch(a.watch!.id, 'tester');
    deleteWatch(b.watch!.id, 'tester');
  });
});

describe('device CRUD primary invariant', () => {
  test('exactly one enabled device stays primary through add/update/delete', () => {
    // getEffectiveDevices() always implies at least one device (env-var-backed 'default'), so the
    // very first explicit createDevice() call materializes THAT as primary first, and the newly
    // added device joins as non-primary - this is what keeps an existing single-device install's
    // primary device stable the moment someone adds a second one, rather than silently reassigning it.
    const a = createDevice({ name: 'device-a', rootDir: '/tmp/device-a' }, 'tester');
    expect(a.isPrimary).toBeFalsy();
    expect(getEffectiveDevices().find((d) => d.id === 'default')?.isPrimary).toBe(true);

    const b = createDevice({ name: 'device-b', rootDir: '/tmp/device-b' }, 'tester');
    expect(b.isPrimary).toBeFalsy();

    updateDevice(b.id, { isPrimary: true }, 'tester');
    const afterPromote = getEffectiveDevices();
    expect(afterPromote.find((d) => d.id === 'default')?.isPrimary).toBeFalsy();
    expect(afterPromote.find((d) => d.id === a.id)?.isPrimary).toBeFalsy();
    expect(afterPromote.find((d) => d.id === b.id)?.isPrimary).toBe(true);

    // Deleting the primary device promotes the next enabled one rather than leaving zero primaries.
    deleteDevice(b.id, 'tester');
    expect(getEffectiveDevices().some((d) => d.isPrimary)).toBe(true);

    deleteDevice(a.id, 'tester');
    deleteDevice('default', 'tester');
  });
});

describe('job history retention', () => {
  test('jobHistoryRetentionDays filters out entries older than the window on the next write', () => {
    updateSettings({ jobHistoryRetentionDays: 1 });
    try {
      const old = { id: randomUUID(), bundleId: 'com.example.old', status: 'done' as const, source: 'manual' as const, createdAt: 0, finishedAt: Date.now() - 2 * 86_400_000 };
      recordJobHistory(old);
      const fresh = { id: randomUUID(), bundleId: 'com.example.fresh', status: 'done' as const, source: 'manual' as const, createdAt: Date.now(), finishedAt: Date.now() };
      recordJobHistory(fresh);

      // The stale entry was purged by the write that added the fresh one, not just excluded from a query.
      const all = getAllJobHistory();
      expect(all.some((e) => e.id === old.id)).toBe(false);
      expect(all.some((e) => e.id === fresh.id)).toBe(true);
    } finally {
      updateSettings({ jobHistoryRetentionDays: 0 });
    }
  });
});

describe('webhook delivery log', () => {
  test('records deliveries newest-first and exposes kind/event/targetHost', () => {
    recordWebhookDelivery({ kind: 'scheduler', event: 'dispatchSuccess', targetHost: 'discord.com', ok: true, status: 200, durationMs: 12 });
    recordWebhookDelivery({ kind: 'job', event: 'job.completed', targetHost: 'example.com', ok: false, error: 'timeout', durationMs: 500 });

    const log = getWebhookDeliveryLog(2);
    expect(log[0].kind).toBe('job');
    expect(log[0].ok).toBe(false);
    expect(log[1].kind).toBe('scheduler');
    expect(log[1].targetHost).toBe('discord.com');
  });
});

describe('device health history', () => {
  test('returns undefined uptime before any check has ever been recorded', () => {
    expect(getDeviceUptimePercent('unused-device')).toBeUndefined();
  });

  test('buckets checks by hour and computes an overall uptime percent', () => {
    recordDeviceHealthCheck('device-a', true);
    recordDeviceHealthCheck('device-a', true);
    recordDeviceHealthCheck('device-a', false);

    // Which of the two hourly buckets the checks land in depends on where "now" falls relative to
    // the hour boundary, so only assert the bucket structure here - getDeviceUptimePercent below
    // filters by raw timestamp instead of a bucket index, which is what's actually load-bearing.
    const buckets = getDeviceHealthHourlyBuckets('device-a', 2);
    expect(buckets).toHaveLength(2);
    expect(buckets.some((b) => b.reachablePercent !== null)).toBe(true);

    const uptime = getDeviceUptimePercent('device-a', 2);
    expect(uptime).toBeCloseTo(2 / 3);
  });
});
