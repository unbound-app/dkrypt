import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  type BillingSubscription,
  canCreateApiKeyImmediately,
  exportBillingSnapshot,
  findStripeCheckoutIdempotencyAttempt,
  getBillingCustomerId,
  getBillingEntitlements,
  hasLegacyBillingRecord,
  isBillingSnapshot,
  recordStripeCheckoutIdempotencyAttempt,
  replaceBillingSnapshot,
  resolveBillingEntitlements,
  upsertBillingSubscription,
} from '#billing.js';
import { dashboardEvents } from '#events.js';
import { PermissionFlag } from '#permissions.js';

function subscription(planId: BillingSubscription['planId'], status = 'active'): BillingSubscription {
  return {
    provider: 'stripe',
    subscriptionId: `sub_${planId}`,
    customerId: 'ctm_test',
    userId: 'github:1',
    status,
    planId,
    priceId: `pri_${planId}`,
    productId: `pro_${planId}`,
    occurredAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

describe('resolveBillingEntitlements', () => {
  test('keeps users without a subscription viewer-only', () => {
    expect(resolveBillingEntitlements([])).toEqual({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });

  test('grants decrypts without API access on the regular plan', () => {
    expect(resolveBillingEntitlements([subscription('regular')])).toMatchObject({
      planId: 'regular',
      decrypt: true,
      api: false,
      priority: 0,
    });
  });

  test('grants API access on the API plan', () => {
    expect(resolveBillingEntitlements([subscription('api')])).toMatchObject({
      planId: 'api',
      decrypt: true,
      api: true,
      priority: 0,
    });
  });

  test('combines API and priority capabilities across subscriptions', () => {
    expect(resolveBillingEntitlements([subscription('api'), subscription('priority')])).toMatchObject({
      decrypt: true,
      api: true,
      priority: 5,
    });
  });

  test('revokes paid capabilities after cancellation', () => {
    expect(resolveBillingEntitlements([subscription('priority_api', 'canceled')])).toMatchObject({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });

  test('keeps legacy provider subscriptions from granting Stripe entitlements', () => {
    expect(resolveBillingEntitlements([{ ...subscription('priority'), provider: 'legacy' }])).toMatchObject({
      planId: 'viewer',
      decrypt: false,
      api: false,
      priority: 0,
    });
  });
});

describe('billing provider cutover', () => {
  test('normalizes and retains old provider records for reconciliation', () => {
    const userId = `legacy-${crypto.randomUUID()}`;
    const snapshot = {
      customers: [{ customerId: `cus_legacy_${crypto.randomUUID()}`, email: 'legacy@example.com', userId, updatedAt: '2026-07-23T00:00:00.000Z' }],
      subscriptions: [{
        subscriptionId: `sub_legacy_${crypto.randomUUID()}`,
        customerId: 'cus_legacy_missing',
        userId,
        status: 'active',
        planId: 'priority',
        priceId: 'price_legacy_priority',
        productId: 'prod_legacy_priority',
        occurredAt: '2026-07-23T00:00:00.000Z',
        updatedAt: '2026-07-23T00:00:00.000Z',
      }],
    };

    expect(isBillingSnapshot(snapshot)).toBe(true);
    replaceBillingSnapshot(snapshot as unknown as BillingSnapshot);
    expect(exportBillingSnapshot()).toMatchObject({ customers: [{ provider: 'legacy' }], subscriptions: [{ provider: 'legacy' }] });
    expect(hasLegacyBillingRecord(userId)).toBe(true);
    expect(getBillingCustomerId(userId)).toBeUndefined();
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
  });
});

describe('billing dashboard updates', () => {
  test('emits invalidation events for accepted subscription changes only', () => {
    const previousSnapshot = exportBillingSnapshot();
    const initial = subscription('regular');
    initial.subscriptionId = `sub_${crypto.randomUUID()}`;
    initial.occurredAt = '2026-07-23T00:00:00.000Z';
    initial.updatedAt = initial.occurredAt;
    const emitted: string[] = [];
    const onBillingChanged = () => emitted.push('changed');
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    dashboardEvents.on('billingChanged', onBillingChanged);

    try {
      expect(upsertBillingSubscription(initial)).toBe(true);
      expect(upsertBillingSubscription({
        ...initial,
        status: 'canceled',
        occurredAt: '2026-07-24T00:00:00.000Z',
        updatedAt: '2026-07-24T00:00:00.000Z',
      })).toBe(true);
      expect(upsertBillingSubscription({ ...initial, status: 'active' })).toBe(false);
      expect(emitted).toHaveLength(2);
    } finally {
      dashboardEvents.off('billingChanged', onBillingChanged);
      replaceBillingSnapshot(previousSnapshot);
    }
  });
});

describe('Stripe checkout idempotency persistence', () => {
  test('retains existing attempts across persisted billing snapshots', () => {
    const previousSnapshot = exportBillingSnapshot();
    const attempt = {
      userId: `checkout-user-${crypto.randomUUID()}`,
      idempotencyKey: `dkrypt-checkout-${crypto.randomUUID()}`,
      requestFingerprint: `fingerprint-${crypto.randomUUID()}`,
      parametersFingerprint: `parameters-${crypto.randomUUID()}`,
      createdAt: Date.now(),
    };

    try {
      recordStripeCheckoutIdempotencyAttempt(attempt);

      expect(findStripeCheckoutIdempotencyAttempt(attempt.userId, attempt.idempotencyKey)).toEqual(attempt);
      expect(exportBillingSnapshot().stripeCheckoutIdempotency).toContainEqual(attempt);
      expect(isBillingSnapshot(exportBillingSnapshot())).toBe(true);
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });

  test('keeps every unexpired attempt when a busy period exceeds ten thousand checkouts', () => {
    const previousSnapshot = exportBillingSnapshot();
    const createdAt = Date.now();
    const retainedAttempts = Array.from({ length: 10_000 }, (_, index) => ({
      userId: `busy-checkout-user-${index}`,
      idempotencyKey: `busy-checkout-key-${index}`,
      requestFingerprint: `busy-checkout-request-${index}`,
      parametersFingerprint: `busy-checkout-parameters-${index}`,
      createdAt,
    }));
    const finalAttempt = {
      userId: 'busy-checkout-final-user',
      idempotencyKey: 'busy-checkout-final-key',
      requestFingerprint: 'busy-checkout-final-request',
      parametersFingerprint: 'busy-checkout-final-parameters',
      createdAt,
    };

    try {
      replaceBillingSnapshot({ ...previousSnapshot, stripeCheckoutIdempotency: retainedAttempts });
      recordStripeCheckoutIdempotencyAttempt(finalAttempt);

      expect(exportBillingSnapshot().stripeCheckoutIdempotency).toHaveLength(10_001);
      expect(findStripeCheckoutIdempotencyAttempt(retainedAttempts[0].userId, retainedAttempts[0].idempotencyKey)).toEqual(retainedAttempts[0]);
      expect(findStripeCheckoutIdempotencyAttempt(finalAttempt.userId, finalAttempt.idempotencyKey)).toEqual(finalAttempt);
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });
});

describe('canCreateApiKeyImmediately', () => {
  test('auto-approves paid API plans and API-key approvers', () => {
    const viewer = resolveBillingEntitlements([]);
    const priority = resolveBillingEntitlements([subscription('priority')]);
    const api = resolveBillingEntitlements([subscription('api')]);

    expect(canCreateApiKeyImmediately(0n, viewer)).toBe(false);
    expect(canCreateApiKeyImmediately(0n, priority)).toBe(false);
    expect(canCreateApiKeyImmediately(0n, api)).toBe(true);
    expect(canCreateApiKeyImmediately(PermissionFlag.approveApiKeys, viewer)).toBe(true);
  });
});
