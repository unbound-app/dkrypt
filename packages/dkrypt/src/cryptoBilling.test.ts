import { describe, expect, test } from 'bun:test';
import {
  exportBillingSnapshot,
  getBillingEntitlements,
  getBillingSubscriptionById,
  getCryptoCheckout,
  listBillingCharges,
  replaceBillingSnapshot,
  upsertCryptoCheckout,
  type BillingCheckout,
  type BillingSubscription,
} from '#billing.js';
import { listManagerBillingSubscriptions, processNowPaymentsEvent } from '#cryptoBilling.js';
import type { NowPaymentsClient } from '#nowpayments.js';

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
  test('omits renewal dates for refunded subscriptions in the manager ledger', () => {
    const previousSnapshot = exportBillingSnapshot();
    const userId = `refunded-member-${crypto.randomUUID()}`;
    const subscription: BillingSubscription = {
      provider: 'stripe',
      subscriptionId: `sub_${crypto.randomUUID()}`,
      customerId: `cus_${crypto.randomUUID()}`,
      userId,
      status: 'revoked',
      planId: 'regular',
      priceId: 'price_regular_test',
      productId: 'prod_regular_test',
      nextBilledAt: '2026-10-29T00:00:00.000Z',
      failureReason: 'payment refunded',
      occurredAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
    };
    replaceBillingSnapshot({ customers: [], subscriptions: [subscription] });

    try {
      const [record] = listManagerBillingSubscriptions({ query: userId });

      expect(record).toMatchObject({ status: 'revoked' });
      expect(record?.nextBilledAt).toBeUndefined();
    } finally {
      replaceBillingSnapshot(previousSnapshot);
    }
  });

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

  test('revokes paid access when NOWPayments confirms a later refund', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-refund-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    upsertCryptoCheckout(localCheckout);
    const finished = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`);
    const finishedAt = new Date(Date.now() - 2_000).toISOString();
    finished.payment.updated_at = finishedAt;
    await processNowPaymentsEvent(finished);

    const refundedAt = new Date(Date.parse(finishedAt) + 1_000).toISOString();
    await processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...finished.payment, payment_status: 'refunded', updated_at: refundedAt },
    });

    const subscriptionId = `nowpayments:${finished.payment.payment_id}`;
    expect(getCryptoCheckout(localCheckout.checkoutId)).toMatchObject({ status: 'completed', providerStatus: 'refunded', providerOccurredAt: refundedAt });
    expect(getBillingSubscriptionById(subscriptionId)).toMatchObject({ status: 'revoked', lastChargeStatus: 'refunded', failureReason: 'payment refunded' });
    expect(listBillingCharges().find((charge) => charge.subscriptionId === subscriptionId)).toMatchObject({ status: 'refunded', failureReason: 'payment refunded' });
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('ignores an older finished webhook after a newer failure', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-stale-finish-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    const failedAt = new Date(Date.now() - 1_000).toISOString();
    failed.payment.updated_at = failedAt;
    await processNowPaymentsEvent(failed);
    const failedCheckout = getCryptoCheckout(localCheckout.checkoutId)!;
    upsertCryptoCheckout({ ...failedCheckout, providerOccurredAt: undefined, providerStatus: undefined });

    const statusLookups: string[] = [];
    const client = {
      getPaymentStatus: async (paymentId: string) => {
        statusLookups.push(paymentId);
        return { ...failed.payment, payment_status: 'failed' };
      },
    } as unknown as NowPaymentsClient;
    await processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...failed.payment, payment_status: 'finished', updated_at: new Date(Date.parse(failedAt) - 1_000).toISOString() },
    }, client);

    const paymentId = String(failed.payment.payment_id);
    expect(statusLookups).toEqual([paymentId]);
    expect(getCryptoCheckout(localCheckout.checkoutId)?.status).toBe('cancelled');
    expect(getBillingSubscriptionById(`nowpayments:${paymentId}`)).toBeUndefined();
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('uses provider state instead of local receipt time for legacy failed checkouts', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-legacy-finish-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failedAt = new Date(Date.now() - 5_000).toISOString();
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    failed.payment.updated_at = failedAt;
    await processNowPaymentsEvent(failed);
    const legacyCheckout = getCryptoCheckout(localCheckout.checkoutId)!;
    upsertCryptoCheckout({ ...legacyCheckout, providerOccurredAt: undefined, providerStatus: undefined });

    const finishedAt = new Date(Date.parse(failedAt) + 1_000).toISOString();
    const finished = { ...failed.payment, payment_status: 'finished', updated_at: finishedAt };
    const client = {
      getPaymentStatus: async () => finished,
    } as unknown as NowPaymentsClient;
    await processNowPaymentsEvent({ id: `evt_${crypto.randomUUID()}`, payment: finished }, client);

    expect(getCryptoCheckout(localCheckout.checkoutId)).toMatchObject({ status: 'completed', providerOccurredAt: finishedAt });
    expect(getBillingSubscriptionById(`nowpayments:${String(failed.payment.payment_id)}`)?.status).toBe('active');
    expect(getBillingEntitlements(userId).planId).toBe(localCheckout.planId);
  });

  test('reconciles conflicting NOWPayments events with the same timestamp', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-same-time-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    const failedAt = new Date(Date.now() - 1_000).toISOString();
    failed.payment.updated_at = failedAt;
    await processNowPaymentsEvent(failed);

    const statusLookups: string[] = [];
    const client = {
      getPaymentStatus: async (paymentId: string) => {
        statusLookups.push(paymentId);
        return { ...failed.payment, payment_status: 'failed' };
      },
    } as unknown as NowPaymentsClient;
    await processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...failed.payment, payment_status: 'finished', updated_at: failedAt },
    }, client);

    expect(statusLookups).toEqual([String(failed.payment.payment_id)]);
    expect(getCryptoCheckout(localCheckout.checkoutId)).toMatchObject({ status: 'cancelled', providerOccurredAt: failedAt, providerStatus: 'failed' });
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('serializes conflicting same-time events for one NOWPayments payment', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-concurrent-same-time-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    const finished = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'finished');
    finished.payment.payment_id = failed.payment.payment_id;
    const occurredAt = new Date(Date.now() - 1_000).toISOString();
    failed.payment.updated_at = occurredAt;
    finished.payment.updated_at = occurredAt;
    const statusLookups: string[] = [];
    const client = {
      getPaymentStatus: async (paymentId: string) => {
        statusLookups.push(paymentId);
        return { ...failed.payment, payment_status: 'failed' };
      },
    } as unknown as NowPaymentsClient;

    await Promise.all([
      processNowPaymentsEvent(failed, client),
      processNowPaymentsEvent(finished, client),
    ]);

    expect(statusLookups).toEqual([String(failed.payment.payment_id)]);
    expect(getCryptoCheckout(localCheckout.checkoutId)).toMatchObject({ status: 'cancelled', providerStatus: 'failed' });
    expect(getBillingSubscriptionById(`nowpayments:${String(failed.payment.payment_id)}`)).toBeUndefined();
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('does not apply an ambiguous same-time event when provider reconciliation fails', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-unavailable-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    const failedAt = new Date(Date.now() - 1_000).toISOString();
    failed.payment.updated_at = failedAt;
    await processNowPaymentsEvent(failed);

    const client = {
      getPaymentStatus: async () => { throw new Error('provider unavailable'); },
    } as unknown as NowPaymentsClient;
    await expect(processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...failed.payment, payment_status: 'finished', updated_at: failedAt },
    }, client)).rejects.toThrow('provider unavailable');

    expect(getCryptoCheckout(localCheckout.checkoutId)).toMatchObject({ status: 'cancelled', providerStatus: 'failed' });
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('does not grant access from a delayed completion after a newer failure', async () => {
    replaceBillingSnapshot({ customers: [], subscriptions: [] });
    const userId = `crypto-race-${crypto.randomUUID()}`;
    const localCheckout = checkout(userId);
    localCheckout.createdAt = new Date(Date.now() - 10_000).toISOString();
    localCheckout.updatedAt = localCheckout.createdAt;
    upsertCryptoCheckout(localCheckout);
    const failedAt = new Date(Date.now() - 2_000).toISOString();
    const failed = paymentEvent(localCheckout, `evt_${crypto.randomUUID()}`, 'failed');
    failed.payment.updated_at = failedAt;
    await processNowPaymentsEvent(failed);

    let signalLookup = () => {};
    let releaseLookup = () => {};
    const lookupStarted = new Promise<void>((resolve) => { signalLookup = resolve; });
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const client = {
      getPaymentStatus: async () => {
        signalLookup();
        await lookupGate;
        return { ...failed.payment, payment_status: 'finished' };
      },
    } as unknown as NowPaymentsClient;
    const staleCompletion = processNowPaymentsEvent({
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...failed.payment, payment_status: 'finished', updated_at: failedAt },
    }, client);
    await lookupStarted;

    const newerFailure = {
      id: `evt_${crypto.randomUUID()}`,
      payment: { ...failed.payment, payment_status: 'failed', updated_at: new Date(Date.parse(failedAt) + 1_000).toISOString() },
    };
    const newerFailureProcessing = processNowPaymentsEvent(newerFailure, client);
    releaseLookup();
    await Promise.all([staleCompletion, newerFailureProcessing]);

    expect(getCryptoCheckout(localCheckout.checkoutId)?.status).toBe('cancelled');
    expect(getBillingSubscriptionById(`nowpayments:${String(failed.payment.payment_id)}`)).toBeUndefined();
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });
});
