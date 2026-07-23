import { describe, expect, test } from 'bun:test';
import { type BillingSubscription, resolveBillingEntitlements } from './billing.js';

function subscription(planId: BillingSubscription['planId'], status = 'active'): BillingSubscription {
  return {
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
});
