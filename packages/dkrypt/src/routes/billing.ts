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
  processExodusEvent,
  verifyExodusEvent,
} from '#cryptoBilling.js';
import { getExodusProviderStatus } from '#exodus.js';
import { normalizeTaxAddress } from '#cryptoTax.js';
import { getAuthProfile, resolveAuthUserId } from '#identity.js';
import { log } from '#logger.js';
import { requirePermission, requireSession } from '#session.js';
import { PermissionFlag } from '#permissions.js';
import { recordAudit } from '#store/state.js';
import { getStripe } from '#stripe.js';

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
    event = await getStripe().webhooks.constructEventAsync(rawBody, signature, config.stripeWebhookSecret);
  } catch (error) {
    log.warn('Stripe webhook signature verification failed', { error: String(error) });
    res.status(400).json({ error: 'invalid webhook signature' });
    return;
  }

  try {
    await processStripeEvent(event);
    res.json({ received: true });
  } catch (error) {
    log.error('Stripe webhook failed', { eventType: event.type, error: String(error) });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

export const exodusWebhookRouter = Router();

exodusWebhookRouter.post('/v1/exodus/webhook', async (req, res) => {
  const signature = req.header('x-signature') ?? '';
  const previousSignature = req.header('x-signature-previous') ?? '';
  const webhookId = req.header('x-webhook-id') ?? '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : '';
  if (!signature || !rawBody) {
    res.status(400).json({ error: 'missing signature or body' });
    return;
  }
  if (!config.exodusWebhookSecret && !config.exodusWebhookSecretPrevious) {
    res.status(503).json({ error: 'Exodus webhook is not configured' });
    return;
  }
  if (!verifyExodusEvent(rawBody, signature, previousSignature)) {
    log.warn('Exodus webhook signature verification failed');
    res.status(400).json({ error: 'invalid webhook signature' });
    return;
  }
  let event: unknown;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    res.status(400).json({ error: 'invalid webhook body' });
    return;
  }
  if (typeof event !== 'object' || event === null || typeof (event as { id?: unknown }).id !== 'string' || typeof (event as { type?: unknown }).type !== 'string') {
    res.status(400).json({ error: 'invalid webhook event' });
    return;
  }
  if (webhookId && webhookId !== (event as { id: string }).id) {
    res.status(400).json({ error: 'webhook id does not match event id' });
    return;
  }
  try {
    await processExodusEvent(event as Parameters<typeof processExodusEvent>[0]);
    res.json({ received: true });
  } catch (error) {
    log.error('Exodus webhook failed', { error: String(error) });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

export const billingRouter = Router();

billingRouter.get('/v1/billing', requireSession, async (_req, res) => {
  const userId = res.locals.session.sub;
  const profile = getAuthProfile(userId);
  const entitlement = getBillingEntitlements(userId);
  const crypto = await getExodusProviderStatus();
  res.json({
    enabled: stripeEnabled || crypto.enabled,
    provider: entitlement.provider ?? 'stripe',
    environment: stripeEnvironment,
    managedPayments: true,
    missingConfiguration: stripeEnabled ? [] : stripeMissingConfiguration,
    providers: {
      stripe: { enabled: stripeEnabled, environment: stripeEnvironment, managedPayments: true, missingConfiguration: stripeMissingConfiguration },
      crypto: { provider: 'exodus', enabled: crypto.enabled, ready: crypto.enabled && crypto.ready, environment: crypto.environment, settlementCurrency: crypto.settlementCurrency, assets: crypto.supportedAssets },
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
  const hasAddress = provider === 'crypto' && req.body?.taxAddress !== undefined;
  const taxAddress = hasAddress ? normalizeTaxAddress(req.body.taxAddress) : undefined;
  if (hasAddress && !taxAddress) {
    res.status(400).json({ error: 'a valid billing country and postal code are required' });
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
      const result = await createCryptoCheckout({ userId, planId: target.id, idempotencyKey, taxAddress });
      res.status(result.reused ? 200 : 201).json({ url: result.checkout.checkoutUrl, provider: 'exodus', checkoutId: result.checkout.checkoutId, status: result.checkout.status });
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
  if (entitlement.provider === 'exodus') {
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
  if (subscription.provider === 'exodus') {
    if (subscription.status === 'cancelled') {
      res.json({ success: true, status: 'cancelled', provider: 'exodus', idempotencyKey });
      return;
    }
    try {
      await cancelCryptoSubscription(userId, subscription);
      res.json({ success: true, status: 'cancelled', provider: 'exodus', idempotencyKey });
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
  res.json({ stripe: { enabled: stripeEnabled, environment: stripeEnvironment, missingConfiguration: stripeMissingConfiguration }, crypto: await getExodusProviderStatus() });
});

billingRouter.get('/v1/billing/subscriptions', requirePermission(PermissionFlag.viewBilling, PermissionFlag.manageBilling), (req, res) => {
  const query = typeof req.query?.q === 'string' ? req.query.q : undefined;
  const provider = typeof req.query?.provider === 'string' ? req.query.provider : undefined;
  const status = typeof req.query?.status === 'string' ? req.query.status : undefined;
  res.json({ subscriptions: listManagerBillingSubscriptions({ query, provider, status }) });
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
