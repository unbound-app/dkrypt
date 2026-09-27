import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { createTestFlightSubscriptionRepository } from '#store/testFlightSubscriptionRepository.js';
import type { TestFlightSubscription } from '#store/state.js';
import { openStateDatabase } from '#store/sqlite.js';

function subscription(overrides: Partial<TestFlightSubscription> = {}): TestFlightSubscription {
  return {
    id: 'subscription-1',
    url: 'https://testflight.apple.com/join/CodeOne',
    inviteCode: 'CodeOne',
    requestedBy: 'member@example.com',
    status: 'approved',
    bundleId: 'com.example.app',
    displayName: 'Example',
    createdAt: 100,
    updatedAt: 200,
    devices: [
      { deviceId: 'device-a', status: 'active', lastVerifiedAt: 150 },
      { deviceId: 'device-b', status: 'unavailable', lastError: 'Offline' },
    ],
    devicePolicy: 'all-enabled',
    ...overrides,
  };
}

test('TestFlight subscription repository scopes users and preserves per-device access', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-testflight-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const repository = createTestFlightSubscriptionRepository(database.db);
  const active = subscription();
  const newer = subscription({ id: 'subscription-2', inviteCode: 'CodeTwo', requestedBy: 'member@example.com', createdAt: 300, updatedAt: 300 });
  const withdrawn = subscription({ id: 'subscription-3', inviteCode: 'CodeThree', status: 'withdrawn', createdAt: 400, updatedAt: 400 });
  const other = subscription({ id: 'subscription-4', inviteCode: 'CodeFour', requestedBy: 'other@example.com', createdAt: 500, updatedAt: 500 });

  try {
    database.writeState({ version: 18, testFlightSubscriptions: [withdrawn, newer, active, other] });

    expect(repository.listByUser('MEMBER@example.com')).toEqual([withdrawn, newer, active]);
    expect(repository.findById(active.id)).toEqual(active);
    expect(repository.findByInviteCode(active.inviteCode)).toEqual(active);
    expect(repository.findByInviteCode(withdrawn.inviteCode)).toBeUndefined();
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('TestFlight subscription migration preserves device-specific enrollment state', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-testflight-repository-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const saved = subscription({ id: 'legacy-subscription', createdAt: 100, updatedAt: 200 });

  try {
    existing.writeState({ version: 18, testFlightSubscriptions: [saved] });
    existing.db.exec(`
      DROP INDEX testflight_subscriptions_by_invite;
      DROP INDEX testflight_subscriptions_by_requester;
      DROP TABLE testflight_subscription_devices;
      DELETE FROM schema_migrations WHERE version = 14;
      ALTER TABLE testflight_subscriptions DROP COLUMN created_at;
      ALTER TABLE testflight_subscriptions DROP COLUMN bundle_id;
      ALTER TABLE testflight_subscriptions DROP COLUMN subscription_status;
      ALTER TABLE testflight_subscriptions DROP COLUMN requester_id;
      ALTER TABLE testflight_subscriptions DROP COLUMN invite_code;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(14);
      expect(createTestFlightSubscriptionRepository(migrated.db).findById(saved.id)).toEqual(saved);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
