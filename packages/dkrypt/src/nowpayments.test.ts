import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { checkoutFromResponse, NowPaymentsClient, subscriptionFromPayment, verifyNowPaymentsWebhook } from '#nowpayments.js';

describe('NOWPayments adapter', () => {
  test('creates a EUR invoice with the selected crypto currency', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ id: 'invoice_test', invoice_url: 'https://nowpayments.test/invoice_test' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new NowPaymentsClient({ baseUrl: 'https://api.example/v1', apiKey: 'api_test', fetchFn });

    const result = await client.createInvoice({
      amount: 10,
      currency: 'EUR',
      payCurrency: 'USDT',
      orderId: 'dkrypt_order',
      orderDescription: 'dkrypt Priority plan',
      ipnCallbackUrl: 'https://dkrypt.test/v1/nowpayments/webhook',
      successUrl: 'https://dkrypt.test/success',
      cancelUrl: 'https://dkrypt.test/cancel',
    });

    expect(result.invoice_url).toBe('https://nowpayments.test/invoice_test');
    expect(requestHeaders?.get('x-api-key')).toBe('api_test');
    expect(requestBody).toMatchObject({ price_amount: 10, price_currency: 'eur', pay_currency: 'usdt', order_id: 'dkrypt_order' });
  });

  test('verifies the sorted JSON IPN signature', () => {
    const payload = { b: 2, a: { d: 4, c: 3 } };
    const canonical = JSON.stringify({ a: { c: 3, d: 4 }, b: 2 });
    const signature = createHmac('sha512', 'ipn_secret').update(canonical).digest('hex');
    expect(verifyNowPaymentsWebhook(payload, signature, 'ipn_secret')).toBe(true);
    expect(verifyNowPaymentsWebhook(payload, `${signature}0`, 'ipn_secret')).toBe(false);
  });

  test('normalizes invoices and payments for the billing ledger', () => {
    const checkout = checkoutFromResponse(
      { id: 'invoice_test', invoice_url: 'https://nowpayments.test/invoice_test' },
      { checkoutId: 'dkrypt_order', orderId: 'dkrypt_order', userId: 'github:123', planId: 'regular', amount: 5, currency: 'EUR', idempotencyKey: 'key', asset: 'USDC' },
    );
    const subscription = subscriptionFromPayment(
      { payment_id: 'payment_test', payment_status: 'finished', price_amount: '5', price_currency: 'eur', pay_currency: 'usdc', pay_address: 'payin' },
      { userId: 'github:123', planId: 'regular', checkoutId: checkout.checkoutId, occurredAt: '2026-09-22T10:00:00.000Z' },
    );

    expect(checkout).toMatchObject({ provider: 'nowpayments', checkoutId: 'dkrypt_order', providerCheckoutId: 'invoice_test', status: 'pending' });
    expect(subscription).toMatchObject({ provider: 'nowpayments', amount: 5, walletAddress: 'payin', asset: 'USDC', providerPaymentId: 'payment_test' });
  });
});
