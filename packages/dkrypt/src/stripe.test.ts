import { createHmac } from 'node:crypto';
import Stripe from 'stripe';
import { describe, expect, test } from 'bun:test';
import {
  getBillingCustomerId,
  getBillingEntitlements,
  replaceBillingSnapshot,
} from '#billing.js';
import { config } from '#config.js';
import { processStripeEvent } from '#routes/billing.js';
import { buildServer } from '#server.js';
import { flushTelemetry } from '#telemetry.js';

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
    const previousSampleRate = config.otelSampleRate;
    config.otelSampleRate = 1;

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': signature,
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        },
        payload,
      });

      expect(response.statusCode).toBe(200);
      expect(getBillingCustomerId(userId)).toBe(customerId);
      const [, traceId, requestSpanId] = String(response.headers.traceparent).split('-');
      const failedEvent = { ...event('customer.subscription.created', {}), data: null } as unknown as Stripe.Event;
      const failedPayload = JSON.stringify(failedEvent);
      const failedDigest = createHmac('sha256', webhookSecret).update(`${timestamp}.${failedPayload}`).digest('hex');
      const failedResponse = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: {
          'content-type': 'application/json',
          'stripe-signature': `t=${timestamp},v1=${failedDigest}`,
          traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4737-00f067aa0ba902b8-01',
        },
        payload: failedPayload,
      });
      expect(failedResponse.statusCode).toBe(500);
      expect(failedResponse.json()).toMatchObject({
        error: 'webhook processing failed',
        code: 'internal_error',
        message: 'webhook processing failed',
        retryable: true,
      });
      const [, failedTraceId, failedRequestSpanId] = String(failedResponse.headers.traceparent).split('-');
      let exportedSpans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status?: { code: number; message?: string } }> = [];
      await flushTelemetry({
        endpoint: 'https://collector.example/v1/traces',
        fetcher: async (_input, init) => {
          const payload = JSON.parse(String(init?.body)) as {
            resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: Record<string, unknown> }>; status?: { code: number; message?: string } }> }> }>;
          };
          exportedSpans = payload.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans));
          return Response.json({});
        },
      });

      const deliverySpan = exportedSpans.find((span) => span.name === 'billing.webhook.delivery' && span.traceId === traceId);
      expect(deliverySpan).toMatchObject({ traceId, parentSpanId: requestSpanId });
      expect(deliverySpan?.attributes).toContainEqual({ key: 'webhook.provider', value: { stringValue: 'stripe' } });
      expect(deliverySpan?.attributes).toContainEqual({ key: 'webhook.status', value: { stringValue: 'processed' } });
      const failedDeliverySpan = exportedSpans.find((span) => span.name === 'billing.webhook.delivery' && span.traceId === failedTraceId);
      expect(failedDeliverySpan).toMatchObject({ traceId: failedTraceId, parentSpanId: failedRequestSpanId, status: { code: 2 } });
      expect(failedDeliverySpan?.attributes).toContainEqual({ key: 'webhook.status', value: { stringValue: 'failed' } });
    } finally {
      await server.close();
      config.otelSampleRate = previousSampleRate;
    }
  });

  test('returns the standard error envelope for an invalid webhook signature', async () => {
    const server = await buildServer({ includePublicRoutes: false });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': 'invalid' },
        payload: '{}',
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: 'invalid webhook signature',
        code: 'request_error',
        message: 'invalid webhook signature',
        retryable: false,
      });
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
      expect(response.json()).toMatchObject({ enabled: true, provider: 'stripe', environment: 'test', missingConfiguration: [], plans: expect.any(Array) });
      expect(response.json()).not.toHaveProperty('clientToken');

      const stripeEvent = checkoutEvent(`stripe-inbox-${crypto.randomUUID()}`, `cus_${crypto.randomUUID()}`, `sub_${crypto.randomUUID()}`, 'checkout.session.async_payment_failed');
      const payload = JSON.stringify(stripeEvent);
      const timestamp = Math.floor(Date.now() / 1000);
      const digest = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`).digest('hex');
      const delivery = await server.inject({
        method: 'POST',
        url: '/v1/stripe/webhook',
        headers: { 'content-type': 'application/json', 'stripe-signature': `t=${timestamp},v1=${digest}` },
        payload,
      });
      expect(delivery.statusCode).toBe(200);

      const inboxResponse = await server.inject({
        method: 'GET',
        url: '/v1/billing/webhooks/inbox?provider=stripe&status=processed&limit=200',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      const inboxResult = inboxResponse.json() as { inbox: Array<Record<string, unknown>>; total: number };
      const record = inboxResult.inbox.find((item) => item.eventId === stripeEvent.id);

      expect(inboxResponse.statusCode).toBe(200);
      expect(record).toMatchObject({ provider: 'stripe', status: 'processed', rawBodyBytes: Buffer.byteLength(payload) });
      expect(record).not.toHaveProperty('rawBody');
      expect(inboxResult.total).toBeGreaterThanOrEqual(1);
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

  test('requires an idempotency key before cancellation', async () => {
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
        url: '/v1/billing/cancel',
        headers: { cookie: cookie.split(';', 1)[0] },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: 'Idempotency-Key must be 1-200 URL-safe characters' });
    } finally {
      await server.close();
    }
  });
});
