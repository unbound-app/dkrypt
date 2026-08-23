import { describe, expect, test } from 'bun:test';
import {
  type BillingSnapshot,
  type BillingSubscription,
  canCreateApiKeyImmediately,
  exportBillingSnapshot,
  getBillingCustomerId,
  getBillingEntitlements,
  hasLegacyBillingRecord,
  isBillingSnapshot,
  replaceBillingSnapshot,
  resolveBillingEntitlements,
} from '#billing.js';
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
