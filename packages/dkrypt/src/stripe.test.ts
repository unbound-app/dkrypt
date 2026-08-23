import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, test } from 'bun:test';
import {
  getBillingCustomerId,
  getBillingEntitlements,
  replaceBillingSnapshot,
} from '#billing.js';
import { processStripeEvent } from '#routes/billing.js';
import { buildServer } from '#server.js';

const webhookSecret = 'whsec_dkrypt_test';

function event(type: string, object: Record<string, unknown>): Stripe.Event {
  return {
    id: `evt_${crypto.randomUUID()}`,
    object: 'event',
    api_version: null,
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type,
  } as unknown as Stripe.Event;
}

function checkoutEvent(userId: string, customerId: string, subscriptionId: string, type = 'checkout.session.completed'): Stripe.Event {
  return event(type, {
    id: `cs_${crypto.randomUUID()}`,
    object: 'checkout.session',
    customer: customerId,
    subscription: subscriptionId,
    metadata: { dkrypt_user_id: userId },
  });
}

function subscriptionEvent(userId: string, customerId: string, subscriptionId: string): Stripe.Event {
  return event('customer.subscription.created', {
    id: subscriptionId,
    object: 'subscription',
    customer: customerId,
    status: 'active',
    metadata: { dkrypt_user_id: userId },
    current_period_end: Math.floor(Date.now() / 1000) + 2_592_000,
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [{ id: 'si_priority_test', current_period_end: Math.floor(Date.now() / 1000) + 2_592_000, price: { id: 'price_priority_test', product: 'prod_priority_test' } }],
    },
  });
}

describe('Stripe billing webhooks', () => {
  test('links checkout sessions and grants the plan from a subscription event', async () => {
    const userId = `stripe-user-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const subscriptionId = `sub_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });

    await processStripeEvent(checkoutEvent(userId, customerId, subscriptionId));
    await processStripeEvent(subscriptionEvent(userId, customerId, subscriptionId));

    expect(getBillingCustomerId(userId)).toBe(customerId);
    expect(getBillingEntitlements(userId)).toMatchObject({ planId: 'priority', decrypt: true, priority: 5 });
  });

  test('keeps async payment failures from granting entitlements', async () => {
    const userId = `stripe-failed-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    replaceBillingSnapshot({ customers: [], subscriptions: [] });

    await processStripeEvent(checkoutEvent(userId, customerId, `sub_${crypto.randomUUID()}`, 'checkout.session.async_payment_failed'));

    expect(getBillingCustomerId(userId)).toBe(customerId);
    expect(getBillingEntitlements(userId).planId).toBe('viewer');
  });

  test('accepts a signed raw webhook request', async () => {
    const userId = `stripe-webhook-${crypto.randomUUID()}`;
    const customerId = `cus_${crypto.randomUUID()}`;
    const payload = JSON.stringify(checkoutEvent(userId, customerId, `sub_${crypto.randomUUID()}`));
    const timestamp = Math.floor(Date.now() / 1000);
    const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`).digest('hex');
    const signature = `t=${timestamp},v1=${digest}`;
    const server = await buildServer({ includePublicRoutes: false });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(getBillingCustomerId(userId)).toBe(customerId);
    } finally {
      await server.close();
    }
  });

  test('exposes Stripe billing metadata without returning a client secret', async () => {
    const server = await buildServer({ includePublicRoutes: false });
    const login = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (typeof cookie !== 'string') throw new Error('login did not set a session cookie');

    try {
      const response = await server.inject({
        method: 'GET',
        url: '/v1/billing',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ enabled: true, provider: 'stripe', environment: 'test', plans: expect.any(Array) });
      expect(response.json()).not.toHaveProperty('clientToken');
    } finally {
      await server.close();
    }
  });

  test('requires an idempotency key before creating checkout', async () => {
    const server = await buildServer({ includePublicRoutes: false });
    const login = await server.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { password: process.env.ADMIN_PASSWORD },
    });
    const cookieHeader = login.headers['set-cookie'];
    const cookie = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
    if (typeof cookie !== 'string') throw new Error('login did not set a session cookie');

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/billing/checkout',
        headers: { cookie: cookie.split(';', 1)[0] },
        payload: { planId: 'regular' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Idempotency-Key must be 1-200 URL-safe characters' });
    } finally {
      await server.close();
    }
  });
});
