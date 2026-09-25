import { createHash, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { Router, type Request, type Response } from '#http.js';
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
import { requirePermission, requireSession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import { recordAudit } from '#store/state.js';
import { constructStripeWebhookEvent, getStripe } from '#stripe.js';
import { claimWebhook, getWebhookInboxRecord, listWebhookInbox, markWebhookFailed, markWebhookProcessed, quarantineWebhook, receiveWebhook, releaseWebhookClaim } from '#webhookInbox.js';
import { paginateCursor } from '#util/cursor.js';

function metadataUserId(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = (metadata as Record<string, unknown>).dkrypt_user_id;
  return typeof value === 'string' && value.length <= 160 ? resolveAuthUserId(value) : undefined;
}

function requireStripeBilling(res: Response): boolean {
  if (stripeEnabled) return true;
  res.status(503).json({ error: 'Stripe billing is not configured' });
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

export const stripeWebhookRouter = Router();

stripeWebhookRouter.post('/v1/stripe/webhook', async (req, res) => {
  const signature = req.header('stripe-signature') ?? '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : '';
  if (!signature || !rawBody) {
    res.status(400).json({ error: 'missing signature or body' });
    return;
  }
  if (!config.stripeSecretKey || !config.stripeWebhookSecret) {
    res.status(503).json({ error: 'Stripe webhook is not configured' });
    return;
  }

  let event: Stripe.Event;
  try {
    event = await constructStripeWebhookEvent(rawBody, signature);
  } catch (error) {
    log.warn('Stripe webhook signature verification failed', { error: String(error) });
    res.status(400).json({ error: 'invalid webhook signature' });
    return;
  }

  const inbox = receiveWebhook('stripe', event.id, rawBody);
  if (inbox.duplicate && inbox.record.status === 'processed') {
    res.json({ received: true, duplicate: true });
    return;
  }
  if (inbox.duplicate && inbox.record.status === 'quarantined') {
    res.json({ received: true, duplicate: true, quarantined: true });
    return;
  }
  if (!claimWebhook(inbox.record.id)) {
    res.json({ received: true, duplicate: true, inProgress: true });
    return;
  }
  try {
    await processStripeEvent(event);
    markWebhookProcessed(inbox.record.id);
    res.json({ received: true });
  } catch (error) {
    markWebhookFailed(inbox.record.id, String(error));
    log.error('Stripe webhook failed', { eventType: event.type, error: String(error) });
    res.status(500).json({ error: 'webhook processing failed' });
  } finally {
    releaseWebhookClaim(inbox.record.id);
  }
});

export const nowpaymentsWebhookRouter = Router();

nowpaymentsWebhookRouter.post('/v1/nowpayments/webhook', async (req, res) => {
  const signature = req.header('x-nowpayments-sig') ?? '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : '';
  if (!signature || !rawBody) {
    res.status(400).json({ error: 'missing signature or body' });
    return;
  }
  if (!config.nowpaymentsIpnSecret && !config.nowpaymentsIpnSecretPrevious) {
    res.status(503).json({ error: 'NOWPayments IPN is not configured' });
    return;
  }
  if (!verifyNowPaymentsEvent(rawBody, signature)) {
    log.warn('NOWPayments IPN signature verification failed');
    res.status(400).json({ error: 'invalid webhook signature' });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid webhook body' });
    return;
  }
  if (typeof payload !== 'object' || payload === null || typeof (payload as { payment_status?: unknown }).payment_status !== 'string') {
    res.status(400).json({ error: 'invalid IPN payload' });
    return;
  }
  const payment = payload as Parameters<typeof processNowPaymentsEvent>[0]['payment'];
  const paymentId = payment.payment_id === undefined ? payment.order_id ?? 'unknown' : String(payment.payment_id);
  const eventId = `nowpayments:${paymentId}:${payment.payment_status}:${payment.updated_at ?? payment.created_at ?? 'unknown'}`;
  const inbox = receiveWebhook('nowpayments', eventId, rawBody);
  if (inbox.duplicate && inbox.record.status === 'processed') {
    res.json({ received: true, duplicate: true });
    return;
  }
  if (inbox.duplicate && inbox.record.status === 'quarantined') {
    res.json({ received: true, duplicate: true, quarantined: true });
    return;
  }
  if (!claimWebhook(inbox.record.id)) {
    res.json({ received: true, duplicate: true, inProgress: true });
    return;
  }
  try {
    await processNowPaymentsEvent({ id: eventId, payment });
    markWebhookProcessed(inbox.record.id);
    res.json({ received: true });
  } catch (error) {
    markWebhookFailed(inbox.record.id, String(error));
    log.error('NOWPayments IPN failed', { error: String(error) });
    res.status(500).json({ error: 'webhook processing failed' });
  } finally {
    releaseWebhookClaim(inbox.record.id);
  }
});

export const billingRouter = Router();

billingRouter.get('/v1/billing', requireSession, async (_req, res) => {
  const userId = res.locals.session.sub;
  const profile = getAuthProfile(userId);
  const entitlement = getBillingEntitlements(userId);
  const crypto = await getNowPaymentsProviderStatus();
  res.json({
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

function getBillingIdempotencyKey(req: Request, res: Response, userId: string, operation: string): string | undefined {
  const key = req.header('idempotency-key') ?? '';
  if (!billingIdempotencyKeyPattern.test(key)) {
    res.status(400).json({ error: 'Idempotency-Key must be 1-200 URL-safe characters' });
    return undefined;
  }
  return `dkrypt-${operation}-${createHash('sha256').update(`${operation}:${userId}:${key}`).digest('hex')}`;
}

function createIntegrationIdentifier(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return `dkrypt_${suffix}`;
}

billingRouter.post('/v1/billing/checkout', requireSession, async (req, res) => {
  const userId = res.locals.session.sub;
  const target = getPlan(typeof req.body?.planId === 'string' ? req.body.planId : '');
  if (!target) {
    res.status(400).json({ error: 'unknown plan' });
    return;
  }
  const provider = req.body?.provider === undefined ? 'stripe' : req.body.provider;
  if (provider !== 'stripe' && provider !== 'crypto') {
    res.status(400).json({ error: 'unsupported billing provider' });
    return;
  }
  const idempotencyKey = getBillingIdempotencyKey(req, res, userId, `checkout-${provider}`);
  if (!idempotencyKey) return;
  if (!acquireBillingCheckoutLock(userId)) {
    res.status(409).json({ error: 'another checkout is already in progress for this account' });
    return;
  }
  if (provider === 'crypto') {
    try {
      const cryptoAsset = typeof req.body?.cryptoAsset === 'string' ? req.body.cryptoAsset : undefined;
      const result = await createCryptoCheckout({ userId, planId: target.id, idempotencyKey, asset: cryptoAsset });
      res.status(result.reused ? 200 : 201).json({ url: result.checkout.checkoutUrl, provider: 'nowpayments', checkoutId: result.checkout.checkoutId, status: result.checkout.status });
    } catch (error) {
      if (error instanceof CryptoBillingError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      log.error('crypto checkout route failed', { userId, planId: target.id, error: String(error) });
      res.status(502).json({ error: 'could not start crypto checkout' });
    } finally {
      releaseBillingCheckoutLock(userId);
    }
    return;
  }
  try {
    if (!requireStripeBilling(res)) return;
    if (hasActiveBillingSubscription(userId)) {
      res.status(409).json({ error: 'this account already has a subscription' });
      return;
    }

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
    if (!session.url) {
      res.status(502).json({ error: 'Stripe did not return a checkout URL' });
      return;
    }
    res.json({ url: session.url });
  } catch (error) {
    log.error('Stripe checkout session failed', { userId, planId: target.id, error: String(error) });
    res.status(502).json({ error: 'could not start checkout' });
  } finally {
    releaseBillingCheckoutLock(userId);
  }
});

billingRouter.post('/v1/billing/portal', requireSession, async (_req, res) => {
  const userId = res.locals.session.sub;
  const entitlement = getBillingEntitlements(userId);
  if (entitlement.provider === 'nowpayments') {
    res.status(409).json({ error: 'crypto subscriptions are managed in dkrypt' });
    return;
  }
  const customerId = getBillingCustomerId(userId);
  if (!customerId) {
    res.status(404).json({ error: 'no Stripe customer exists for this account' });
    return;
  }
  if (!requireStripeBilling(res)) return;

  try {
    const portal = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: `${config.publicBaseUrl}/?tab=billing`,
    });
    res.json({ url: portal.url });
  } catch (error) {
    log.error('Stripe portal session failed', { userId, error: String(error) });
    res.status(502).json({ error: 'could not open the billing portal' });
  }
});

billingRouter.post('/v1/billing/cancel', requireSession, async (req, res) => {
  const userId = res.locals.session.sub;
  const idempotencyKey = getBillingIdempotencyKey(req, res, userId, 'cancel');
  if (!idempotencyKey) return;
  const entitlement = getBillingEntitlements(userId);
  if (!entitlement.subscriptionId) {
    res.status(404).json({ error: 'no active subscription exists for this account' });
    return;
  }
  const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
  if (!subscription) {
    res.status(404).json({ error: 'subscription does not belong to this account' });
    return;
  }
  if (subscription.provider === 'nowpayments') {
    if (subscription.status === 'cancelled') {
      res.json({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
      return;
    }
    try {
      await cancelCryptoSubscription(userId, subscription);
      res.json({ success: true, status: 'cancelled', provider: 'nowpayments', idempotencyKey });
    } catch (error) {
      if (error instanceof CryptoBillingError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(502).json({ error: 'could not cancel the crypto subscription' });
    }
    return;
  }
  if (!requireStripeBilling(res)) return;
  if (subscription.scheduledChangeAction === 'cancel') {
    res.json({ success: true, status: subscription.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
    return;
  }
  try {
    const updated = await getStripe().subscriptions.update(subscription.subscriptionId, { cancel_at_period_end: true });
    persistStripeSubscription(updated, new Date().toISOString(), userId);
    recordAudit(userId, 'billing.cancel', subscription.subscriptionId, 'Stripe cancellation scheduled');
    res.json({ success: true, status: updated.status, cancelAtPeriodEnd: true, provider: 'stripe', idempotencyKey });
  } catch (error) {
    log.error('Stripe subscription cancellation failed', { userId, subscriptionId: subscription.subscriptionId, error: String(error) });
    res.status(502).json({ error: 'could not cancel the subscription' });
  }
});

billingRouter.get('/v1/billing/provider-status', requirePermission(PermissionFlag.manageBilling), async (_req, res) => {
  res.json({ stripe: { enabled: stripeEnabled, environment: stripeEnvironment, missingConfiguration: stripeMissingConfiguration }, crypto: await getNowPaymentsProviderStatus() });
});

billingRouter.get('/v1/billing/subscriptions', requirePermission(PermissionFlag.viewBilling, PermissionFlag.manageBilling), (req, res) => {
  const query = typeof req.query?.q === 'string' ? req.query.q : undefined;
  const provider = typeof req.query?.provider === 'string' ? req.query.provider : undefined;
  const status = typeof req.query?.status === 'string' ? req.query.status : undefined;
  const planId = typeof req.query?.planId === 'string' ? req.query.planId : undefined;
  const from = typeof req.query?.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query?.to === 'string' ? req.query.to : undefined;
  const wallet = typeof req.query?.wallet === 'string' ? req.query.wallet : undefined;
  const invoice = typeof req.query?.invoice === 'string' ? req.query.invoice : undefined;
  const limit = Math.min(Math.max(Number.parseInt(String(req.query?.limit ?? '50'), 10) || 50, 1), 100);
  const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : undefined;
  const offset = cursor ? 0 : Math.max(Number.parseInt(String(req.query?.offset ?? '0'), 10) || 0, 0);
  const subscriptions = listManagerBillingSubscriptions({ query, provider, status, planId, from, to, wallet, invoice });
  const page = paginateCursor(subscriptions, {
    cursor,
    offset,
    limit,
    keyOf: (subscription) => [
      typeof subscription.updatedAt === 'string' ? subscription.updatedAt : '',
      typeof subscription.provider === 'string' ? subscription.provider : '',
      typeof subscription.subscriptionId === 'string' ? subscription.subscriptionId : '',
    ],
    order: 'desc',
  });
  res.json({ subscriptions: page.items, total: subscriptions.length, nextCursor: page.nextCursor });
});

billingRouter.get('/v1/billing/webhooks/inbox', requirePermission(PermissionFlag.manageBilling), (req, res) => {
  const status = typeof req.query?.status === 'string' ? req.query.status : undefined;
  const provider = typeof req.query?.provider === 'string' ? req.query.provider : undefined;
  const filtered = listWebhookInbox()
    .filter((record) => !status || record.status === status)
    .filter((record) => !provider || record.provider === provider);
  const limit = Math.min(Math.max(Number.parseInt(String(req.query?.limit ?? '50'), 10) || 50, 1), 200);
  const cursor = typeof req.query?.cursor === 'string' ? req.query.cursor : undefined;
  const offset = cursor ? 0 : Math.max(Number.parseInt(String(req.query?.offset ?? '0'), 10) || 0, 0);
  const page = paginateCursor(filtered, {
    cursor,
    offset,
    limit,
    keyOf: (record) => [record.receivedAt, record.id],
    order: 'desc',
  });
  const inbox = page.items.map(({ rawBody, ...record }) => ({ ...record, rawBodyBytes: Buffer.byteLength(rawBody) }));
  res.json({ inbox, total: filtered.length, nextCursor: page.nextCursor });
});

billingRouter.post('/v1/billing/webhooks/inbox/:id/quarantine', requirePermission(PermissionFlag.manageBilling), (req, res) => {
  const current = getWebhookInboxRecord(req.params.id);
  if (!current) {
    res.status(404).json({ error: 'webhook inbox record not found' });
    return;
  }
  const reason = typeof req.body?.reason === 'string' && req.body.reason.trim() ? req.body.reason.trim() : 'quarantined by manager';
  const record = quarantineWebhook(current.id, reason);
  res.json({ record: record ? { ...record, rawBody: undefined } : undefined });
});

billingRouter.post('/v1/billing/webhooks/inbox/:id/replay', requirePermission(PermissionFlag.manageBilling), async (req, res) => {
  const current = getWebhookInboxRecord(req.params.id);
  if (!current) {
    res.status(404).json({ error: 'webhook inbox record not found' });
    return;
  }
  if (current.status === 'processed') {
    res.json({ replayed: false, duplicate: true, status: current.status });
    return;
  }
  if (!claimWebhook(current.id)) {
    res.status(409).json({ error: 'webhook is already being processed' });
    return;
  }
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
    recordAudit(res.locals.session.sub, 'billing.webhook.replay', current.eventId, current.provider);
    res.json({ replayed: true, status: 'processed' });
  } catch (error) {
    markWebhookFailed(current.id, String(error));
    res.status(500).json({ error: 'webhook replay failed' });
  } finally {
    releaseWebhookClaim(current.id);
  }
});

billingRouter.post('/v1/billing/subscription', requireSession, async (req, res) => {
  const userId = res.locals.session.sub;
  const target = getPlan(typeof req.body?.planId === 'string' ? req.body.planId : '');
  if (!target) {
    res.status(400).json({ error: 'unknown plan' });
    return;
  }
  if (!requireStripeBilling(res)) return;

  const entitlement = getBillingEntitlements(userId);
  if (!entitlement.subscriptionId) {
    res.status(409).json({ error: 'complete checkout before changing plans' });
    return;
  }
  const subscription = getBillingSubscription(userId, entitlement.subscriptionId);
  if (!subscription) {
    res.status(403).json({ error: 'subscription does not belong to this account' });
    return;
  }
  if (subscription.provider !== 'stripe') {
    res.status(409).json({ error: 'crypto plan changes require cancellation and a new checkout' });
    return;
  }
  const current = getPlan(subscription.planId);

  try {
    const stripeSubscription = await getStripe().subscriptions.retrieve(subscription.subscriptionId);
    const item = stripeSubscription.items.data.find((candidate) => candidate.id === subscription.subscriptionItemId) ?? stripeSubscription.items.data[0];
    if (!item) {
      res.status(502).json({ error: 'subscription has no billable item' });
      return;
    }
    const updated = await getStripe().subscriptions.update(subscription.subscriptionId, {
      items: [{ id: item.id, price: target.priceId, quantity: item.quantity ?? 1 }],
      proration_behavior: current && target.amount > current.amount ? 'always_invoice' : 'create_prorations',
      payment_behavior: 'error_if_incomplete',
    });
    persistStripeSubscription(updated, new Date().toISOString(), userId);
    res.json({
      success: true,
      status: updated.status,
      priceId: typeof updated.items.data[0]?.price === 'string' ? updated.items.data[0].price : updated.items.data[0]?.price.id ?? null,
    });
  } catch (error) {
    log.error('Stripe subscription update failed', { userId, planId: target.id, error: String(error) });
    if (typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === 402) {
      res.status(402).json({ error: 'payment confirmation is required; use Manage billing to complete the change' });
      return;
    }
    res.status(502).json({ error: 'subscription update failed; your existing plan was not changed' });
  }
});
