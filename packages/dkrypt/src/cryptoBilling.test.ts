import { describe, expect, test } from 'bun:test';
import {
  getBillingEntitlements,
  getBillingSubscriptionById,
  getCryptoCheckout,
  listBillingCharges,
  replaceBillingSnapshot,
  upsertCryptoCheckout,
  type BillingCheckout,
} from '#billing.js';
import { processExodusEvent } from '#cryptoBilling.js';

function checkout(userId: string): BillingCheckout {
  return {
    provider: 'exodus',
    checkoutId: `schk_${crypto.randomUUID()}`,
    userId,
    idempotencyKey: `key_${crypto.randomUUID()}`,
    planId: 'priority',
    amount: 10,
    currency: 'EUR',
    status: 'pending',
    checkoutUrl: 'https://checkout.exodus.test/checkout',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function checkoutEvent(checkoutRecord: BillingCheckout, eventId: string) {
  return {
    id: eventId,
    type: 'subscription_checkout.completed',
    created_at: new Date().toISOString(),
    data: {
      object: {
        id: checkoutRecord.checkoutId,
        status: 'completed',
        metadata: { plan_id: checkoutRecord.planId, dkrypt_user_id: checkoutRecord.userId },
      },
      subscription: {
        id: `sub_${crypto.randomUUID()}`,
        status: 'active',
        external_customer_id: `dkrypt:${checkoutRecord.userId}`,
        subscriber: '0x123',
        token_symbol: 'USDT',
        chain: 'eip155:8453',
        price: '1000',
        price_currency: 'EUR',
        charge_nonce: 0,
        subscription_manager_address: '0xmanager',
      },
      first_charge: { id: `subc_${crypto.randomUUID()}`, amount: '1000', charge_nonce: 0, tx_hash: '0xtx', chain: 'eip155:8453' },
    },
  };
}

describe('crypto billing lifecycle', () => {
  test('activates a subscription from a verified checkout event and deduplicates delivery', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-user-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    upsertCryptoCheckout(localCheckout);
    const event = checkoutEvent(localCheckout, `evt_${crypto.randomUUID()}`);

    await processExodusEvent(event);
    await processExodusEvent(event);

    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', provider: 'exodus', decrypt: true, priority: 5 });
    const subscriptionId = (event.data.subscription as { id: string }).id;
    expect(getBillingSubscriptionById(subscriptionId)).toMatchObject({ amount: 10, lastChargeTxHash: '0xtx', lastChargeStatus: 'succeeded' });
    expect(listBillingCharges().find((charge) => charge.subscriptionId === subscriptionId)).toMatchObject({ amount: 10, tokenAmount: '1000', txHash: '0xtx' });
  });

  test('keeps a completed checkout when an older status webhook arrives later', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-order-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = '2026-09-22T08:00:00.000Z';
    localCheckout.updatedAt = '2026-09-22T08:00:00.000Z';
    upsertCryptoCheckout(localCheckout);

    const completed = checkoutEvent(localCheckout, `evt_${crypto.randomUUID()}`);
    completed.created_at = '2026-09-22T10:00:00.000Z';
    await processExodusEvent(completed);
    await processExodusEvent({
      id: `evt_${crypto.randomUUID()}`,
      type: 'subscription_checkout.created',
      created_at: '2026-09-22T09:00:00.000Z',
      data: { object: { id: localCheckout.checkoutId, status: 'pending' } },
    });

    expect(getCryptoCheckout(localCheckout.checkoutId)?.status).toBe('completed');
  });
});
