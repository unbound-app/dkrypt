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
import { processNowPaymentsEvent } from '#cryptoBilling.js';

function checkout(userId: string): BillingCheckout {
  const checkoutId = `dkrypt_${crypto.randomUUID()}`;
  return {
    provider: 'nowpayments',
    checkoutId,
    providerCheckoutId: `invoice_${crypto.randomUUID()}`,
    orderId: checkoutId,
    userId,
    idempotencyKey: `key_${crypto.randomUUID()}`,
    planId: 'priority',
    amount: 10,
    currency: 'EUR',
    status: 'pending',
    checkoutUrl: 'https://nowpayments.test/invoice',
    asset: 'USDT',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function paymentEvent(localCheckout: BillingCheckout, eventId: string, status = 'finished') {
  return {
    id: eventId,
    payment: {
      payment_id: `payment_${crypto.randomUUID()}`,
      payment_status: status,
      order_id: localCheckout.orderId,
      price_amount: '10',
      price_currency: 'eur',
      pay_amount: '10.05',
      actually_paid: '10.05',
      pay_currency: 'usdt',
      pay_address: 'Tpayin',
      payin_hash: '0xtx',
      created_at: '2026-09-22T10:00:00.000Z',
      updated_at: '2026-09-22T10:00:00.000Z',
    },
  };
}

describe('crypto billing lifecycle', () => {
  test('activates a plan from a verified payment and deduplicates delivery', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-user-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    upsertCryptoCheckout(localCheckout);
    const event = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`);

    await processNowPaymentsEvent(event);
    await processNowPaymentsEvent(event);

    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', provider: 'nowpayments', decrypt: true, priority: 5 });
    const subscriptionId = `nowpayments:${(event.payment as { payment_id: string }).payment_id}`;
    expect(getBillingSubscriptionById(subscriptionId)).toMatchObject({ amount: 10, lastChargeTxHash: '0xtx', lastChargeStatus: 'succeeded' });
    expect(listBillingCharges().find((charge) => charge.subscriptionId === subscriptionId)).toMatchObject({ amount: 10, tokenAmount: '10.05', txHash: '0xtx' });
  });

  test('keeps a completed invoice when an older pending webhook arrives later', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-order-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = '2026-09-22T08:00:00.000Z';
    localCheckout.updatedAt = '2026-09-22T08:00:00.000Z';
    upsertCryptoCheckout(localCheckout);

    const completed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`);
    await processNowPaymentsEvent(completed);
    await processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...completed.payment, payment_status: 'waiting', updated_at: '2026-09-22T09:00:00.000Z' },
    });

    expect(getCryptoCheckout(localCheckout.checkoutId)?.status).toBe('completed');
  });
});
