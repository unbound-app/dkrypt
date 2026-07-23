import {
  EventName,
  type CustomerCreatedEvent,
  type CustomerUpdatedEvent,
  type EventEntity,
  type SubscriptionCanceledEvent,
  type SubscriptionCreatedEvent,
  type SubscriptionUpdatedEvent,
  type TransactionCompletedEvent,
} from '@paddle/paddle-node-sdk';
import { Router } from 'express';
import {
  getBillingCustomerId,
  getBillingEntitlements,
  getBillingSubscription,
  getBillingSubscriptionIds,
  getPlan,
  linkBillingCustomer,
  listPlans,
  planForPrice,
  upsertBillingCustomer,
  upsertBillingSubscription,
} from '../billing.js';
import { config, paddleEnabled } from '../config.js';
import { getAuthProfile } from '../identity.js';
import { log } from '../logger.js';
import { getPaddle } from '../paddle.js';
import { requireSession } from '../session.js';

type SubscriptionEvent = SubscriptionCreatedEvent | SubscriptionUpdatedEvent | SubscriptionCanceledEvent;
type CustomerEvent = CustomerCreatedEvent | CustomerUpdatedEvent;

function customDataUserId(customData: unknown): string | undefined {
  if (typeof customData !== 'object' || customData === null) return undefined;
  const value = (customData as Record<string, unknown>).dkrypt_user_id;
  return typeof value === 'string' && value.length <= 160 ? value : undefined;
}

function processSubscription(event: SubscriptionEvent): void {
  const subscription = event.data;
  const price = subscription.items[0]?.price;
  if (!price) return;
  const planId = planForPrice(price.id);
  if (!planId) return;

  upsertBillingSubscription({
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    userId: customDataUserId(subscription.customData),
    status: subscription.status,
    planId,
    priceId: price.id,
    productId: price.productId,
    nextBilledAt: subscription.nextBilledAt ?? undefined,
    scheduledChangeAction: subscription.scheduledChange?.action,
    scheduledChangeAt: subscription.scheduledChange?.effectiveAt,
    occurredAt: event.occurredAt,
    updatedAt: subscription.updatedAt,
  });
}

function processCustomer(event: CustomerEvent): void {
  const customer = event.data;
  upsertBillingCustomer({
    customerId: customer.id,
    email: customer.email,
    userId: customDataUserId(customer.customData),
    updatedAt: customer.updatedAt,
  });
}

function processTransaction(event: TransactionCompletedEvent): void {
  const customerId = event.data.customerId;
  const userId = customDataUserId(event.data.customData);
  if (customerId && userId) linkBillingCustomer(customerId, userId);
}

function processEvent(event: EventEntity): void {
  switch (event.eventType) {
    case EventName.CustomerCreated:
    case EventName.CustomerUpdated:
      processCustomer(event);
      return;
    case EventName.SubscriptionCreated:
    case EventName.SubscriptionUpdated:
    case EventName.SubscriptionCanceled:
      processSubscription(event);
      return;
    case EventName.TransactionCompleted:
      processTransaction(event);
      return;
  }
}

export const paddleWebhookRouter = Router();

paddleWebhookRouter.post('/v1/paddle/webhook', async (req, res) => {
  const signature = req.header('paddle-signature') ?? '';
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  if (!signature || !rawBody) {
    res.status(400).json({ error: 'missing signature or body' });
    return;
  }
  if (!config.paddleWebhookSecret) {
    res.status(503).json({ error: 'Paddle webhook secret is not configured' });
    return;
  }

  try {
    const event = await getPaddle().webhooks.unmarshal(rawBody, config.paddleWebhookSecret, signature);
    processEvent(event);
    res.json({ received: true });
  } catch (error) {
    log.error('Paddle webhook failed', { error: String(error) });
    res.status(500).json({ error: 'webhook processing failed' });
  }
});

export const billingRouter = Router();

billingRouter.get('/v1/billing', requireSession, (_req, res) => {
  const userId = res.locals.session.sub;
  const profile = getAuthProfile(userId);
  res.json({
    enabled: paddleEnabled,
    environment: config.paddleEnvironment,
    clientToken: paddleEnabled ? config.paddleClientToken : undefined,
    plans: listPlans(),
    customerId: getBillingCustomerId(userId),
    customerEmail: profile?.email,
    entitlement: getBillingEntitlements(userId),
  });
});

billingRouter.post('/v1/billing/portal', requireSession, async (_req, res) => {
  const userId = res.locals.session.sub;
  const customerId = getBillingCustomerId(userId);
  if (!customerId) {
    res.status(404).json({ error: 'no Paddle customer exists for this account' });
    return;
  }

  try {
    const portal = await getPaddle().customerPortalSessions.create(customerId, getBillingSubscriptionIds(userId));
    res.json({ url: portal.urls.general.overview });
  } catch (error) {
    log.error('Paddle portal session failed', { userId, error: String(error) });
    res.status(502).json({ error: 'could not open the billing portal' });
  }
});

billingRouter.post('/v1/billing/subscription', requireSession, async (req, res) => {
  const userId = res.locals.session.sub;
  const target = getPlan(typeof req.body?.planId === 'string' ? req.body.planId : '');
  if (!target) {
    res.status(400).json({ error: 'unknown plan' });
    return;
  }

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
  const current = getPlan(subscription.planId);
  const prorationBillingMode =
    !current || target.amount > current.amount ? 'prorated_immediately' : 'prorated_next_billing_period';

  try {
    const updated = await getPaddle().subscriptions.update(subscription.subscriptionId, {
      items: [{ priceId: target.priceId, quantity: 1 }],
      prorationBillingMode,
    });
    res.json({
      success: true,
      status: updated.status,
      priceId: updated.items[0]?.price?.id ?? null,
    });
  } catch (error) {
    log.error('Paddle subscription update failed', { userId, planId: target.id, error: String(error) });
    res.status(502).json({ error: 'subscription update failed; your existing plan was not changed' });
  }
});
