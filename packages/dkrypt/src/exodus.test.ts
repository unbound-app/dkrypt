import { createHmac } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { ExodusClient, checkoutFromResponse, subscriptionFromResponse, verifyExodusWebhook } from '#exodus.js';

describe('Exodus Checkout adapter', () => {
  test('creates a EUR subscription checkout with a stable request shape', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestHeaders: Headers | undefined;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requestHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ id: 'schk_test', status: 'pending', checkout_url: 'https://checkout.exodus.test/schk_test' }), { status: 201 });
    }) as unknown as typeof fetch;
    const client = new ExodusClient({ baseUrl: 'https://checkout.example', apiKey: 'sk_test_key', fetchFn });

    const result = await client.createSubscriptionCheckout({
      userId: 'github:123',
      planId: 'priority',
      planName: 'Priority',
      planDescription: 'Priority access',
      amount: 10,
      currency: 'EUR',
      idempotencyKey: 'checkout-key',
      successUrl: 'https://dkrypt.test/success',
      cancelUrl: 'https://dkrypt.test/cancel',
    });

    expect(result.checkout_url).toBe('https://checkout.exodus.test/schk_test');
    expect(requestHeaders?.get('authorization')).toBe('Bearer sk_test_key');
    expect(requestHeaders?.get('idempotency-key')).toBe('checkout-key');
    expect(requestBody).toMatchObject({ price: '1000', price_currency: 'EUR', period_duration: 2_592_000, supported_chains: ['eip155:8453'] });
    expect(requestBody?.metadata).toMatchObject({ dkrypt_user_id: 'github:123', plan_id: 'priority', plan_name: 'Priority' });
  });

  test('verifies raw webhook bytes with HMAC-SHA256', () => {
    const body = Buffer.from('{"id":"evt_test"}');
    const secret = 'whsec_test';
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyExodusWebhook(body, signature, secret)).toBe(true);
    expect(verifyExodusWebhook(body, `${signature}0`, secret)).toBe(false);
  });

  test('normalizes provider records for the billing ledger', () => {
    const checkout = checkoutFromResponse(
      { id: 'schk_test', status: 'pending', checkout_url: 'https://checkout.exodus.test/schk_test' },
      { userId: 'github:123', planId: 'regular', amount: 5, currency: 'EUR', idempotencyKey: 'key' },
    );
    const subscription = subscriptionFromResponse(
      {
        id: 'sub_test',
        status: 'active',
        external_customer_id: 'dkrypt:github:123',
        subscriber: '0x123',
        token_symbol: 'USDC',
        chain: 'eip155:8453',
        price: '500',
        price_currency: 'EUR',
        charge_nonce: 0,
        subscription_manager_address: '0xmanager',
      },
      { userId: 'github:123', planId: 'regular', checkoutId: checkout.checkoutId },
    );

    expect(checkout).toMatchObject({ provider: 'exodus', checkoutId: 'schk_test', status: 'pending' });
    expect(subscription).toMatchObject({ provider: 'exodus', amount: 5, walletAddress: '0x123', chain: 'eip155:8453', asset: 'USDC' });
  });
});
