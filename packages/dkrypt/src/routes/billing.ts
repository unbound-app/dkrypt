import { createHash, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type {
  BillingCancelRoute,
  BillingCheckoutRoute,
  BillingSubscriptionRoute,
  BillingSubscriptionsRoute,
  BillingWebhookInboxParamsRoute,
  BillingWebhookInboxRoute,
  BillingWebhookQuarantineRoute,
} from '#billingContracts.js';
import { getRouteContract } from '#contracts.js';
import {
  acquireBillingCheckoutLock,
  getBillingCustomerId,
  getBillingEntitlements,
  getBillingSubscription,
  getBillingUserId,
  getPlan,
  hasActiveBillingSubscription,
  hasLegacyBillingRecord,
  linkBillingCustomer,
  listBillingSubscriptions,
  listPlans,
  planForPrice,
  upsertBillingCustomer,
  upsertBillingSubscription,
  releaseBillingCheckoutLock,
} from '#billing.js';
import { config, stripeEnabled, stripeEnvironment, stripeMissingConfiguration } from '#config.js';
import {
  cancelCryptoSubscription,
  createCryptoCheckout,
  CryptoBillingError,
  listManagerBillingSubscriptions,
  processNowPaymentsEvent,
  verifyNowPaymentsEvent,
} from '#cryptoBilling.js';
import { getNowPaymentsProviderStatus } from '#nowpayments.js';
import { getAuthProfile, resolveAuthUserId } from '#identity.js';
import { log } from '#logger.js';
import { fastifyRequirePermission, fastifyRequireSession, getFastifySession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import { recordAudit } from '#store/state.js';
import { constructStripeWebhookEvent, getStripe } from '#stripe.js';
import { claimWebhook, getWebhookInboxRecord, listWebhookInbox, markWebhookFailed, markWebhookProcessed, quarantineWebhook, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';
import { decodeCursor, nextCursor, paginateCursor } from '#util/cursor.js';

function metadataUserId(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = (metadata as Record<string, unknown>).dkrypt_user_id;
  return typeof value === 'string' && value.length <= 160 ? resolveAuthUserId(value) : undefined;
}

function sendBillingError(request: FastifyRequest, reply: FastifyReply, statusCode: number, message: string) {
  return reply.code(statusCode).send({
    error: message,
    code: statusCode >= 500 ? 'internal_error' : 'request_error',
    message,
    requestId: request.id,
    retryable: statusCode >= 500 || statusCode === 429 || statusCode === 503,
  });
}

function requireStripeBilling(request: FastifyRequest, reply: FastifyReply): boolean {
  if (stripeEnabled) return true;
  sendBillingError(request, reply, 503, 'Stripe billing is not configured');
  return false;
}

function stripeObjectId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

function eventDate(event: Stripe.Event): string {
  return new Date(event.created * 1000).toISOString();
}

function unixDate(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000).toISOString() : undefined;
}

function processCustomer(event: Stripe.Event): void {
  const customer = event.data.object as Stripe.Customer;
  if (!customer?.id) return;
  upsertBillingCustomer({
    provider: 'stripe',
    customerId: customer.id,
    email: customer.email ?? '',
    userId: metadataUserId(customer.metadata),
    updatedAt: eventDate(event),
  });
}

function processCheckoutSession(event: Stripe.Event): void {
  const session = event.data.object as Stripe.Checkout.Session;
  const customerId = stripeObjectId(session.customer);
  const userId = metadataUserId(session.metadata);
  if (customerId && userId) linkBillingCustomer(customerId, userId);
}

function persistStripeSubscription(subscription: Stripe.Subscription, occurredAt: string, fallbackUserId?: string): void {
  const item = subscription.items?.data?.[0];
  const customerId = stripeObjectId(subscription.customer);
  if (!item || !customerId) return;

  const price = typeof item.price === 'string' ? undefined : item.price;
  const priceId = typeof item.price === 'string' ? item.price : price?.id;
  const productId = stripeObjectId(price?.product);
  if (!priceId || !productId) return;
  const planId = planForPrice(priceId);
  if (!planId) return;

  const scheduledChangeAction = subscription.cancel_at_period_end || subscription.cancel_at ? 'cancel' : undefined;
  const scheduledChangeAt = subscription.cancel_at
    ? unixDate(subscription.cancel_at)
    : subscription.cancel_at_period_end
      ? unixDate(item.current_period_end)
      : undefined;

  upsertBillingSubscription({
    provider: 'stripe',
    subscriptionId: subscription.id,
    customerId,
    userId: metadataUserId(subscription.metadata) ?? fallbackUserId ?? getBillingUserId(customerId),
    status: subscription.status,
    planId,
    priceId,
    productId,
    subscriptionItemId: item.id,
    nextBilledAt: scheduledChangeAction ? undefined : unixDate(item.current_period_end),
    scheduledChangeAction,
    scheduledChangeAt,
    occurredAt,
    updatedAt: occurredAt,
  });
}

function processSubscription(event: Stripe.Event): void {
  persistStripeSubscription(event.data.object as Stripe.Subscription, eventDate(event));
}

export async function processStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
    case 'checkout.session.async_payment_failed':
      processCheckoutSession(event);
      return;
    case 'customer.created':
    case 'customer.updated':
      processCustomer(event);
      return;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      processSubscription(event);
      return;
  }
}

interface WebhookDeliveryResult {
  statusCode: 200 | 500;
  payload: Record<string, unknown>;
}

function webhookSignatureHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

function webhookRawBody(body: unknown): Buffer | undefined {
  const rawBody = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body) : undefined;
  return rawBody?.length ? rawBody : undefined;
}

async function processWebhookDelivery(
  provider: 'stripe' | 'nowpayments',
  eventId: string,
  rawBody: Buffer,
  processEvent: () => Promise<void>,
  onFailure: (error: unknown) => void,
): Promise<WebhookDeliveryResult> {
  const inbox = receiveWebhook(provider, eventId, rawBody);
  if (inbox.duplicate && inbox.record.status === 'processed') return { statusCode: 200, payload: { received: true, duplicate: true } };
  if (inbox.duplicate && inbox.record.status === 'quarantined') return { statusCode: 200, payload: { received: true, duplicate: true, quarantined: true } };
  if (!claimWebhook(inbox.record.id)) return { statusCode: 200, payload: { received: true, duplicate: true, inProgress: true } };
  try {
    await processEvent();
    markWebhookProcessed(inbox.record.id);
    return { statusCode: 200, payload: { received: true } };
  } catch (error) {
    markWebhookFailed(inbox.record.id, String(error));
    onFailure(error);
    return { statusCode: 500, payload: { error: 'webhook processing failed' } };
  } finally {
    releaseWebhookClaim(inbox.record.id);
  }
}

export const billingWebhookRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.post('/v1/stripe/webhook', { schema: getRouteContract('POST', '/v1/stripe/webhook') }, async (request, reply) => {
    const signature = webhookSignatureHeader(request.headers['stripe-signature']);
    const rawBody = webhookRawBody(request.body);
    if (!signature || !rawBody) return sendBillingError(request, reply, 400, 'missing signature or body');
    if (!config.stripeSecretKey || !config.stripeWebhookSecret) return sendBillingError(request, reply, 503, 'Stripe webhook is not configured');

    let event: Stripe.Event;
    try {
      event = await constructStripeWebhookEvent(rawBody, signature);
    } catch (error) {
      log.warn('Stripe webhook signature verification failed', { error: String(error) });
      return sendBillingError(request, reply, 400, 'invalid webhook signature');
    }

    const result = await processWebhookDelivery('stripe', event.id, rawBody, () => processStripeEvent(event), (error) => {
      log.error('Stripe webhook failed', { eventType: event.type, error: String(error) });
    });
    return reply.code(result.statusCode).send(result.payload);
  });

  server.post('/v1/nowpayments/webhook', { schema: getRouteContract('POST', '/v1/nowpayments/webhook') }, async (request, reply) => {
    const signature = webhookSignatureHeader(request.headers['x-nowpayments-sig']);
    const rawBody = webhookRawBody(request.body);
    if (!signature || !rawBody) return sendBillingError(request, reply, 400, 'missing signature or body');
    if (!config.nowpaymentsIpnSecret && !config.nowpaymentsIpnSecretPrevious) return sendBillingError(request, reply, 503, 'NOWPayments IPN is not configured');
    if (!verifyNowPaymentsEvent(rawBody, signature)) {
      log.warn('NOWPayments IPN signature verification failed');
      return sendBillingError(request, reply, 400, 'invalid webhook signature');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendBillingError(request, reply, 400, 'invalid webhook body');
    }
    if (typeof payload !== 'object' || payload === null || typeof (payload as { payment_status?: unknown }).payment_status !== 'string') {
      return sendBillingError(request, reply, 400, 'invalid IPN payload');
    }
    const payment = payload as Parameters<typeof processNowPaymentsEvent>[0]['payment'];
    const paymentId = payment.payment_id === undefined ? payment.order_id ?? 'unknown' : String(payment.payment_id);
    const eventId = `nowpayments:${paymentId}:${payment.payment_status}:${payment.updated_at ?? payment.created_at ?? 'unknown'}`;
    const result = await processWebhookDelivery('nowpayments', eventId, rawBody, () => processNowPaymentsEvent({ id: eventId, payment }), (error) => {
      log.error('NOWPayments IPN failed', { error: String(error) });
    });
    return reply.code(result.statusCode).send(result.payload);
  });
};

export const billingRoutes: FastifyPluginAsyncTypebox = async (server) => {
  server.get('/v1/billing', { schema: getRouteContract('GET', '/v1/billing'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const profile = getAuthProfile(userId);
    const entitlement = getBillingEntitlements(userId);
    const crypto = await getNowPaymentsProviderStatus();
    return reply.send({
      enabled: stripeEnabled || crypto.enabled,
      provider: entitlement.provider ?? 'stripe',
      environment: stripeEnvironment,
      managedPayments: true,
      missingConfiguration: stripeEnabled ? [] : stripeMissingConfiguration,
      providers: {
        stripe: { enabled: stripeEnabled, environment: stripeEnvironment, managedPayments: true, missingConfiguration: stripeMissingConfiguration },
        crypto: { provider: 'nowpayments', enabled: crypto.enabled, ready: crypto.enabled && crypto.ready, environment: crypto.environment, settlementCurrency: crypto.settlementCurrency, assets: crypto.supportedAssets },
      },
      plans: listPlans(),
      customerId: getBillingCustomerId(userId),
      customerEmail: profile?.email,
      legacyBilling: hasLegacyBillingRecord(userId),
      entitlement,
    });
  });

  const billingIdempotencyKeyPattern = /^[A-Za-z0-9._~-]{1,200}$/;

  function getBillingIdempotencyKey(request: FastifyRequest, reply: FastifyReply, userId: string, operation: string): string | undefined {
    const header = request.headers['idempotency-key'];
    const key = Array.isArray(header) ? header[0] ?? '' : header ?? '';
    if (!billingIdempotencyKeyPattern.test(key)) {
      sendBillingError(request, reply, 400, 'Idempotency-Key must be 1-200 URL-safe characters');
      return undefined;
    }
    return `dkrypt-${operation}-${createHash('sha256').update(`${operation}:${userId}:${key}`).digest('hex')}`;
  }

  function createIntegrationIdentifier(): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const suffix = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
    return `dkrypt_${suffix}`;
  }

  server.post<BillingCheckoutRoute>('/v1/billing/checkout', { schema: getRouteContract('POST', '/v1/billing/checkout'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const target = getPlan(request.body.planId);
    if (!target) return sendBillingError(request, reply, 400, 'unknown plan');
    const provider = request.body.provider ?? 'stripe';
    const idempotencyKey = getBillingIdempotencyKey(request, reply, userId, `checkout-${provider}`);
    if (!idempotencyKey) return;
    if (!acquireBillingCheckoutLock(userId)) return sendBillingError(request, reply, 409, 'another checkout is already in progress for this account');
    if (provider === 'crypto') {
      try {
        const result = await createCryptoCheckout({ userId, planId: target.id, idempotencyKey, asset: request.body.cryptoAsset });
        return reply.code(result.reused ? 200 : 201).send({ url: result.checkout.checkoutUrl, provider: 'nowpayments', checkoutId: result.checkout.checkoutId, status: result.checkout.status });
      } catch (error) {
        if (error instanceof CryptoBillingError) return sendBillingError(request, reply, error.statusCode, error.message);
        log.error('crypto checkout route failed', { userId, planId: target.id, error: String(error) });
        return sendBillingError(request, reply, 502, 'could not start crypto checkout');
      } finally {
        releaseBillingCheckoutLock(userId);
      }
    }
    try {
      if (!requireStripeBilling(request, reply)) return;
      if (hasActiveBillingSubscription(userId)) return sendBillingError(request, reply, 409, 'this account already has a subscription');

      const profile = getAuthProfile(userId);
      const customerId = getBillingCustomerId(userId);
      const session = await getStripe().checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: target.priceId, quantity: 1 }],
        customer: customerId,
        customer_email: customerId ? undefined : profile?.email,
        client_reference_id: userId,
        metadata: { dkrypt_user_id: userId, plan_id: target.id },
        subscription_data: { metadata: { dkrypt_user_id: userId, plan_id: target.id } },
        success_url: `${config.publicBaseUrl}/?tab=billing&checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${config.publicBaseUrl}/?tab=billing&checkout=cancelled`,
        billing_address_collection: 'required',
        managed_payments: { enabled: true },
        integration_identifier: createIntegrationIdentifier(),
      }, { idempotencyKey });
      if (!session.url) return sendBillingError(request, reply, 502, 'Stripe did not return a checkout URL');
      return reply.send({ url: session.url });
    } catch (error) {
      log.error('Stripe checkout session failed', { userId, planId: target.id, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not start checkout');
    } finally {
      releaseBillingCheckoutLock(userId);
    }
  });

  server.post('/v1/billing/portal', { schema: getRouteContract('POST', '/v1/billing/portal'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const entitlement = getBillingEntitlements(userId);
    if (entitlement.provider === 'nowpayments') return sendBillingError(request, reply, 409, 'crypto subscriptions are managed in dkrypt');
    const customerId = getBillingCustomerId(userId);
    if (!customerId) return sendBillingError(request, reply, 404, 'no Stripe customer exists for this account');
    if (!requireStripeBilling(request, reply)) return;

    try {
      const portal = await getStripe().billingPortal.sessions.create({
        customer: customerId,
        return_url: `${config.publicBaseUrl}/?tab=billing`,
      });
      return reply.send({ url: portal.url });
    } catch (error) {
      log.error('Stripe portal session failed', { userId, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not open the billing portal');
    }
  });

  server.post<BillingCancelRoute>('/v1/billing/cancel', { schema: getRouteContract('POST', '/v1/billing/cancel'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const idempotencyKey = getBillingIdempotencyKey(request, reply, userId, 'cancel');
    if (!idempotencyKey) return;
    const entitlement = getBillingEntitlements(userId);
    if (!entitlement.subscriptionId) return sendBillingError(request, reply, 404, 'no active subscription exists for this account');
    const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
    if (!subscription) return sendBillingError(request, reply, 404, 'subscription does not belong to this account');
    if (subscription.provider === 'nowpayments') {
      if (subscription.status === 'cancelled') return reply.send({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
      try {
        await cancelCryptoSubscription(userId, subscription);
        return reply.send({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
      } catch (error) {
        if (error instanceof CryptoBillingError) return sendBillingError(request, reply, error.statusCode, error.message);
        return sendBillingError(request, reply, 502, 'could not cancel the crypto subscription');
      }
    }
    if (!requireStripeBilling(request, reply)) return;
    if (subscription.scheduledChangeAction === 'cancel') return reply.send({ success: true, status: subscription.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
    try {
      const updated = await getStripe().subscriptions.update(subscription.subscriptionId, { cancel_at_period_end: true });
      persistStripeSubscription(updated, new Date().toISOString(), userId);
      recordAudit(userId, 'billing.cancel', subscription.subscriptionId, 'Stripe cancellation scheduled');
      return reply.send({ success: true, status: updated.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
    } catch (error) {
      log.error('Stripe subscription cancellation failed', { userId, subscriptionId: subscription.subscriptionId, error: String(error) });
      return sendBillingError(request, reply, 502, 'could not cancel the subscription');
    }
  });

  const requireBillingManager = fastifyRequirePermission(PermissionFlag.manageBilling);

  server.get('/v1/billing/provider-status', { schema: getRouteContract('GET', '/v1/billing/provider-status'), preHandler: requireBillingManager }, async (_request, reply) => {
    return reply.send({ stripe: { enabled: stripeEnabled, environment: stripeEnvironment, missingConfiguration: stripeMissingConfiguration }, crypto: await getNowPaymentsProviderStatus() });
  });

  server.get<BillingSubscriptionsRoute>('/v1/billing/subscriptions', { schema: getRouteContract('GET', '/v1/billing/subscriptions'), preHandler: fastifyRequirePermission(PermissionFlag.viewBilling, PermissionFlag.manageBilling) }, (request, reply) => {
    const { q: query, provider, status, planId, from, to, wallet, invoice, limit: requestedLimit, cursor, offset: requestedOffset } = request.query;
    const limit = Math.min(Math.max(requestedLimit ?? 50, 1), 100);
    const offset = cursor ? 0 : Math.max(requestedOffset ?? 0, 0);
    const subscriptionOrder = new Map(
      listBillingSubscriptions().map((subscription, index) => [`${subscription.provider}:${subscription.subscriptionId}`, index]),
    );
    const subscriptions = listManagerBillingSubscriptions({ query, provider, status, planId, from, to, wallet, invoice });
    const page = paginateCursor(subscriptions, {
      cursor,
      offset,
      limit,
      keyOf: (subscription) => [
        subscriptionOrder.get(`${String(subscription.provider)}:${String(subscription.subscriptionId)}`) ?? Number.MAX_SAFE_INTEGER,
        typeof subscription.provider === 'string' ? subscription.provider : '',
        typeof subscription.subscriptionId === 'string' ? subscription.subscriptionId : '',
      ],
      order: 'asc',
    });
    return reply.send({ subscriptions: page.items, total: subscriptions.length, nextCursor: page.nextCursor });
  });

  server.get<BillingWebhookInboxRoute>('/v1/billing/webhooks/inbox', { schema: getRouteContract('GET', '/v1/billing/webhooks/inbox'), preHandler: requireBillingManager }, (request, reply) => {
    const { status, provider, limit: requestedLimit, cursor, offset: requestedOffset } = request.query;
    const filtered = listWebhookInbox()
      .filter((record) => !status || record.status === status)
      .filter((record) => !provider || record.provider === provider);
    const limit = Math.min(Math.max(requestedLimit ?? 50, 1), 200);
    const offset = cursor ? decodeCursor(cursor) : Math.max(requestedOffset ?? 0, 0);
    const page = filtered.slice(offset, offset + limit).map(({ rawBody, ...record }) => ({ ...record, rawBodyBytes: Buffer.byteLength(rawBody) }));
    return reply.send({ inbox: page, total: filtered.length, nextCursor: nextCursor(offset, page.length, filtered.length) });
  });

  server.post<BillingWebhookQuarantineRoute>('/v1/billing/webhooks/inbox/:id/quarantine', { schema: getRouteContract('POST', '/v1/billing/webhooks/inbox/:id/quarantine'), preHandler: requireBillingManager }, (request, reply) => {
    const current = getWebhookInboxRecord(request.params.id);
    if (!current) return sendBillingError(request, reply, 404, 'webhook inbox record not found');
    const reason = request.body.reason?.trim() || 'quarantined by manager';
    const record = quarantineWebhook(current.id, reason);
    return reply.send({ record: record ? { ...record, rawBody: undefined } : undefined });
  });

  server.post<BillingWebhookInboxParamsRoute>('/v1/billing/webhooks/inbox/:id/replay', { schema: getRouteContract('POST', '/v1/billing/webhooks/inbox/:id/replay'), preHandler: requireBillingManager }, async (request, reply) => {
    const current = getWebhookInboxRecord(request.params.id);
    if (!current) return sendBillingError(request, reply, 404, 'webhook inbox record not found');
    if (current.status === 'processed') return reply.send({ replayed: false, duplicate: true, status: current.status });
    if (!claimWebhook(current.id)) return sendBillingError(request, reply, 409, 'webhook is already being processed');
    try {
      const payload = JSON.parse(current.rawBody) as Record<string, unknown>;
      if (current.provider === 'stripe') {
        if (typeof payload.id !== 'string' || typeof payload.type !== 'string' || typeof payload.data !== 'object' || payload.data === null) throw new Error('stored Stripe event is malformed');
        await processStripeEvent(payload as unknown as Stripe.Event);
      } else {
        if (typeof payload.payment_status !== 'string') throw new Error('stored NOWPayments event is malformed');
        await processNowPaymentsEvent({ id: current.eventId, payment: payload as Parameters<typeof processNowPaymentsEvent>[0]['payment'] });
      }
      markWebhookProcessed(current.id);
      recordAudit(getFastifySession(request)!.sub, 'billing.webhook.replay', current.eventId, current.provider);
      return reply.send({ replayed: true, status: 'processed' });
    } catch (error) {
      markWebhookFailed(current.id, String(error));
      return sendBillingError(request, reply, 500, 'webhook replay failed');
    } finally {
      releaseWebhookClaim(current.id);
    }
  });

  server.post<BillingSubscriptionRoute>('/v1/billing/subscription', { schema: getRouteContract('POST', '/v1/billing/subscription'), preHandler: fastifyRequireSession }, async (request, reply) => {
    const userId = getFastifySession(request)!.sub;
    const target = getPlan(request.body.planId);
    if (!target) return sendBillingError(request, reply, 400, 'unknown plan');
    if (!requireStripeBilling(request, reply)) return;

    const entitlement = getBillingEntitlements(userId);
    if (!entitlement.subscriptionId) return sendBillingError(request, reply, 409, 'complete checkout before changing plans');
    const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
    if (!subscription) return sendBillingError(request, reply, 403, 'subscription does not belong to this account');
    if (subscription.provider !== 'stripe') return sendBillingError(request, reply, 409, 'crypto plan changes require cancellation and a new checkout');
    const current = getPlan(subscription.planId);

    try {
      const stripeSubscription = await getStripe().subscriptions.retrieve(subscription.subscriptionId);
      const item = stripeSubscription.items.data.find((candidate) => candidate.id === subscription.subscriptionItemId) ?? stripeSubscription.items.data[0];
      if (!item) return sendBillingError(request, reply, 502, 'subscription has no billable item');
      const updated = await getStripe().subscriptions.update(subscription.subscriptionId, {
        items: [{ id: item.id, price: target.priceId, quantity: item.quantity ?? 1 }],
        proration_behavior: current && target.amount > current.amount ? 'always_invoice' : 'create_prorations',
        payment_behavior: 'error_if_incomplete',
      });
      persistStripeSubscription(updated, new Date().toISOString(), userId);
      return reply.send({
        success: true,
        status: updated.status,
        priceId: typeof updated.items.data[0]?.price === 'string' ? updated.items.data[0].price : updated.items.data[0]?.price.id ?? null,
      });
    } catch (error) {
      log.error('Stripe subscription update failed', { userId, planId: target.id, error: String(error) });
      if (typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === 402) {
        return sendBillingError(request, reply, 402, 'payment confirmation is required; use Manage billing to complete the change');
      }
      return sendBillingError(request, reply, 502, 'subscription update failed; your existing plan was not changed');
    }
  });
};
