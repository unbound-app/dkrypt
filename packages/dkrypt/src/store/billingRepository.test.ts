import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'bun:test';
import { billingSnapshotCollections, type BillingCharge, type BillingCheckout, type BillingEntitlementEvent, type BillingEventRecord, type BillingSnapshot, type BillingSubscription } from '#billing.js';
import { createBillingRepository } from '#store/billingRepository.js';
import { LATEST_SQLITE_SCHEMA_VERSION, openStateDatabase, replaceStateCollections } from '#store/sqlite.js';

function billingSnapshot(): BillingSnapshot {
  const subscription: BillingSubscription = {
    provider: 'nowpayments',
    subscriptionId: 'nowpayments:payment-1',
    customerId: 'member@example.com',
    userId: 'member@example.com',
    status: 'active',
    planId: 'priority',
    priceId: 'crypto-priority',
    productId: 'crypto-product',
    checkoutId: 'invoice-1',
    providerPaymentId: 'payment-1',
    currency: 'EUR',
    amount: 10,
    walletAddress: '0xAbCdEf',
    chain: 'base',
    asset: 'usdcbase',
    occurredAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  };
  const checkout: BillingCheckout = {
    provider: 'nowpayments',
    checkoutId: 'invoice-1',
    providerCheckoutId: 'provider-invoice-1',
    providerPaymentId: 'payment-1',
    userId: 'member@example.com',
    idempotencyKey: 'checkout-key-1',
    planId: 'priority',
    amount: 10,
    currency: 'EUR',
    status: 'completed',
    checkoutUrl: 'https://pay.example/invoice-1',
    asset: 'usdcbase',
    createdAt: '2026-09-26T09:55:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  };
  const charge: BillingCharge = {
    provider: 'nowpayments',
    chargeId: 'charge-1',
    subscriptionId: subscription.subscriptionId,
    userId: 'member@example.com',
    status: 'succeeded',
    amount: 10,
    currency: 'EUR',
    tokenAmount: '10.00',
    asset: 'usdcbase',
    chain: 'base',
    txHash: '0xtx1',
    chargeNonce: 1,
    occurredAt: '2026-09-26T10:00:00.000Z',
    updatedAt: '2026-09-26T10:00:00.000Z',
  };
  const entitlement: BillingEntitlementEvent = {
    id: 'entitlement-1',
    userId: 'member@example.com',
    subscriptionId: subscription.subscriptionId,
    provider: 'nowpayments',
    planId: 'priority',
    kind: 'grant',
    status: 'active',
    at: '2026-09-26T10:00:00.000Z',
    detail: 'payment confirmed',
  };
  const processedEvent: BillingEventRecord = {
    provider: 'nowpayments',
    eventId: 'event-1',
    occurredAt: '2026-09-26T10:00:00.000Z',
    processedAt: '2026-09-26T10:00:01.000Z',
  };

  return {
    customers: [{ provider: 'nowpayments', customerId: 'member@example.com', email: '', userId: 'member@example.com', updatedAt: '2026-09-26T10:00:00.000Z' }],
    subscriptions: [subscription],
    cryptoCheckouts: [checkout],
    cryptoCharges: [charge],
    processedEvents: [processedEvent],
    entitlementHistory: [entitlement],
  };
}

function billingSnapshotWithProvider(snapshot: BillingSnapshot, provider: string): BillingSnapshot {
  return {
    ...snapshot,
    customers: snapshot.customers.map((record) => ({ ...record, provider })),
    subscriptions: snapshot.subscriptions.map((record) => ({ ...record, provider })),
    cryptoCheckouts: snapshot.cryptoCheckouts.map((record) => ({ ...record, provider })),
    cryptoCharges: snapshot.cryptoCharges.map((record) => ({ ...record, provider })),
    processedEvents: snapshot.processedEvents.map((record) => ({ ...record, provider })),
    entitlementHistory: snapshot.entitlementHistory?.map((record) => ({ ...record, provider })),
  } as unknown as BillingSnapshot;
}

test('billing repository replaces and reloads typed snapshots across database reopen', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-billing-repository-snapshot-'));
  const options = { stateDir, filename: 'state.sqlite' };
  let database = openStateDatabase(options);
  const snapshot = billingSnapshot();

  try {
    createBillingRepository(database.db).replaceSnapshot(snapshot);
    expect(createBillingRepository(database.db).loadSnapshot()).toEqual({ kind: 'snapshot', value: snapshot });
    database.close();

    database = openStateDatabase(options);
    const repository = createBillingRepository(database.db);
    expect(repository.loadSnapshot()).toEqual({ kind: 'snapshot', value: snapshot });
    expect(repository.listSubscriptions()).toEqual(snapshot.subscriptions);
    expect(repository.listCustomers()).toEqual(snapshot.customers);
    expect(repository.listCheckouts()).toEqual(snapshot.cryptoCheckouts);
    expect(repository.listCharges()).toEqual(snapshot.cryptoCharges);
    expect(repository.listProcessedEvents()).toEqual(snapshot.processedEvents);
    expect(repository.listEntitlementHistory()).toEqual(snapshot.entitlementHistory ?? []);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('billing repository filters subscriptions and retrieves durable payment history', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-billing-repository-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const snapshot = billingSnapshot();

  try {
    replaceStateCollections(database.db, [
      ...billingSnapshotCollections(snapshot),
      {
        table: 'auth_profiles',
        rows: [{ id: 'member@example.com', payload: { kind: 'profile', value: { userId: 'member@example.com', displayName: 'Morgan Example', username: 'morgan', email: 'member@example.com' } }, updatedAt: Date.now() }],
      },
    ]);
    const repository = createBillingRepository(database.db);

    expect(repository.listSubscriptions({ provider: 'nowpayments', status: 'active', planId: 'priority', query: 'MEMBER@EXAMPLE.COM', wallet: '0xabc', invoice: 'payment-1' })).toEqual(snapshot.subscriptions);
    expect(repository.listSubscriptions({ query: 'MORGAN EXAMPLE' })).toEqual(snapshot.subscriptions);
    expect(repository.listSubscriptions({ userId: 'member@example.com' })).toEqual(snapshot.subscriptions);
    expect(repository.listSubscriptions({ status: 'cancelled' })).toEqual([]);
    expect(repository.listCustomers()).toEqual(snapshot.customers);
    expect(repository.findCustomer('nowpayments', 'member@example.com')).toEqual(snapshot.customers[0]);
    expect(repository.findCheckout('invoice-1')).toEqual(snapshot.cryptoCheckouts[0]);
    expect(repository.findCheckoutByUserKey('member@example.com', 'checkout-key-1')).toEqual(snapshot.cryptoCheckouts[0]);
    expect(repository.listCheckouts()).toEqual(snapshot.cryptoCheckouts);
    expect(repository.findCharge('charge-1')).toEqual(snapshot.cryptoCharges[0]);
    expect(repository.findChargeForNonce('nowpayments:payment-1', 1)).toEqual(snapshot.cryptoCharges[0]);
    expect(repository.listCharges()).toEqual(snapshot.cryptoCharges);
    expect(repository.listChargesForSubscription('nowpayments:payment-1')).toEqual(snapshot.cryptoCharges);
    expect(repository.listEntitlementHistory('nowpayments:payment-1')).toEqual(snapshot.entitlementHistory ?? []);
    expect(repository.listProcessedEvents()).toEqual(snapshot.processedEvents);
    expect(repository.hasProcessedEvent('nowpayments', 'event-1')).toBe(true);
    expect(repository.hasProcessedEvent('legacy', 'event-1')).toBe(false);
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('billing snapshot collections normalize retired Exodus provider records', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-billing-legacy-'));
  const database = openStateDatabase({ stateDir, filename: 'state.sqlite' });
  const snapshot = billingSnapshot();
  const historicSnapshot = billingSnapshotWithProvider(snapshot, 'exodus');

  try {
    replaceStateCollections(database.db, billingSnapshotCollections(historicSnapshot));
    const repository = createBillingRepository(database.db);

    expect(repository.listCustomers()[0]?.provider).toBe('legacy');
    expect(repository.listSubscriptions()[0]?.provider).toBe('legacy');
    expect(repository.listCheckouts()[0]?.provider).toBe('legacy');
    expect(repository.listCharges()[0]?.provider).toBe('legacy');
    expect(repository.listProcessedEvents()[0]?.provider).toBe('legacy');
    expect(repository.listEntitlementHistory()[0]?.provider).toBe('legacy');
  } finally {
    database.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('billing migration backfills indexed records from the prior JSON snapshot', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'dkrypt-billing-migration-'));
  const options = { stateDir, filename: 'state.sqlite' };
  const existing = openStateDatabase(options);
  const snapshot = billingSnapshot();
  const historicSnapshot = billingSnapshotWithProvider(snapshot, 'exodus');
  const normalizedSnapshot = billingSnapshotWithProvider(snapshot, 'legacy');

  try {
    existing.db.query('INSERT INTO billing_records (id, payload, updated_at) VALUES (?, ?, ?)').run(
      'billing-snapshot',
      JSON.stringify({ kind: 'snapshot', value: historicSnapshot }),
      Date.now(),
    );
    existing.db.exec(`
      DROP TABLE billing_customers;
      DROP TABLE billing_subscriptions;
      DROP TABLE billing_checkouts;
      DROP TABLE billing_charges;
      DROP TABLE billing_entitlement_history;
      DROP INDEX billing_events_by_provider_event;
      DROP INDEX billing_events_by_processed_at;
      ALTER TABLE billing_events DROP COLUMN provider;
      ALTER TABLE billing_events DROP COLUMN event_id;
      ALTER TABLE billing_events DROP COLUMN occurred_at;
      ALTER TABLE billing_events DROP COLUMN processed_at;
      DELETE FROM schema_migrations WHERE version = 17;
    `);
    existing.close();

    const migrated = openStateDatabase(options);
    try {
      expect(migrated.schemaVersion).toBe(LATEST_SQLITE_SCHEMA_VERSION);
      const repository = createBillingRepository(migrated.db);
      expect(repository.listCustomers()).toEqual(normalizedSnapshot.customers);
      expect(repository.listSubscriptions()).toEqual(normalizedSnapshot.subscriptions);
      expect(repository.listCheckouts()).toEqual(normalizedSnapshot.cryptoCheckouts);
      expect(repository.listCharges()).toEqual(normalizedSnapshot.cryptoCharges);
      expect(repository.listProcessedEvents()).toEqual(normalizedSnapshot.processedEvents);
      expect(repository.listEntitlementHistory()).toEqual(normalizedSnapshot.entitlementHistory ?? []);
    } finally {
      migrated.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
