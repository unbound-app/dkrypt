import { config, cryptoBillingEnabled, exodusConfigured } from '#config.js';
import {
  getCryptoCheckout,
  findCryptoCheckout,
  getBillingChargeForNonce,
  getBillingSubscriptionById,
  getPlan,
  hasActiveBillingSubscription,
  hasProcessedBillingEvent,
  listBillingCharges,
  listBillingSubscriptions,
  recordBillingEvent,
  upsertBillingCharge,
  upsertBillingSubscription,
  upsertCryptoCheckout,
  type BillingCharge,
  type BillingCheckout,
  type BillingSubscription,
  type BillingTaxAddress,
  type PlanId,
} from '#billing.js';
import {
  checkoutFromResponse,
  ExodusApiError,
  ExodusClient,
  getExodusProviderStatus,
  isSupportedExodusSubscription,
  subscriptionFromResponse,
  verifyExodusWebhookWithRotation,
  type ExodusEvent,
  type ExodusSubscription,
} from '#exodus.js';
import { getAuthProfile } from '#identity.js';
import { log } from '#logger.js';
import { notify, EMBED_COLOR } from '#notify.js';
import { recordAudit } from '#store/state.js';
import { calculateCryptoTax, recordCryptoTaxTransaction } from '#cryptoTax.js';

const CHARGE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export class CryptoBillingError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'CryptoBillingError';
  }
}

export interface CryptoCheckoutResult {
  checkout: BillingCheckout;
  reused: boolean;
}

export async function createCryptoCheckout(input: {
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  idempotencyKey: string;
  taxAddress?: BillingTaxAddress;
}): Promise<CryptoCheckoutResult> {
  const existing = findCryptoCheckout(input.userId, input.idempotencyKey);
  if (existing) return { checkout: existing, reused: true };
  if (!cryptoBillingEnabled) throw new CryptoBillingError('crypto billing is not enabled', 503);
  if (hasActiveBillingSubscription(input.userId)) throw new CryptoBillingError('this account already has a subscription', 409);

  const plan = getPlan(input.planId);
  if (!plan) throw new CryptoBillingError('unknown plan', 400);
  const providerStatus = await getExodusProviderStatus();
  if (!providerStatus.ready) throw new CryptoBillingError(`crypto billing is not ready: ${providerStatus.issues.join(', ')}`, 503);
  if (!input.taxAddress) throw new CryptoBillingError('billing address is required for crypto checkout', 400);

  let taxCalculationId: string | undefined;
  if (input.taxAddress) {
    const tax = await calculateCryptoTax({ amount: plan.amount, planId: plan.id, address: input.taxAddress, idempotencyKey: `dkrypt-tax-checkout-${input.idempotencyKey}` });
    taxCalculationId = tax.calculationId;
  }

  const client = new ExodusClient();
  try {
    const response = await client.createSubscriptionCheckout({
      userId: input.userId,
      planId: plan.id,
      planName: plan.name,
      planDescription: plan.description,
      amount: plan.amount,
      currency: plan.currency,
      taxAddress: input.taxAddress,
      taxCalculationId,
      idempotencyKey: input.idempotencyKey,
      successUrl: `${config.publicBaseUrl}/?tab=billing&crypto_checkout=success`,
      cancelUrl: `${config.publicBaseUrl}/?tab=billing&crypto_checkout=cancelled`,
    });
    const checkout = checkoutFromResponse(response, {
      userId: input.userId,
      planId: plan.id,
      amount: plan.amount,
      currency: plan.currency,
      idempotencyKey: input.idempotencyKey,
      taxAddress: input.taxAddress,
      taxCalculationId,
      taxStatus: taxCalculationId ? 'pending' : 'not_required',
    });
    upsertCryptoCheckout(checkout);
    recordAudit(input.userId, 'billing.checkout', checkout.checkoutId, `exodus ${plan.id}`);
    return { checkout, reused: false };
  } catch (error) {
    log.error('Exodus checkout failed', { userId: input.userId, planId: plan.id, error: String(error) });
    if (error instanceof ExodusApiError) throw new CryptoBillingError('could not start crypto checkout', 502);
    throw error;
  }
}

export async function cancelCryptoSubscription(userId: string, subscription: BillingSubscription): Promise<void> {
  if (subscription.provider !== 'exodus') throw new CryptoBillingError('this subscription is not managed by Exodus', 409);
  const client = new ExodusClient();
  try {
    const remote = await client.getSubscription(subscription.subscriptionId);
    await client.cancelSubscription(remote);
    const now = new Date().toISOString();
    upsertBillingSubscription({ ...subscription, status: 'cancelled', nextBilledAt: undefined, scheduledChangeAction: undefined, scheduledChangeAt: undefined, occurredAt: now, updatedAt: now });
    recordAudit(userId, 'billing.cancel', subscription.subscriptionId, 'exodus subscription cancelled');
    await notify('cryptoBillingSuccess', {
      title: 'Crypto subscription cancelled',
      description: `Your ${subscription.planId} subscription has been cancelled.`,
      color: EMBED_COLOR.ok,
    });
  } catch (error) {
    log.error('Exodus subscription cancellation failed', { userId, subscriptionId: subscription.subscriptionId, error: String(error) });
    throw new CryptoBillingError('could not cancel the crypto subscription', 502);
  }
}

export async function processExodusEvent(event: ExodusEvent): Promise<void> {
  if (!event.id || hasProcessedEvent(event.id)) return;
  const occurredAt = eventDate(event.created_at);
  const data = recordOf(event.data);
  const object = recordOf(data.object ?? data.subscription ?? data.charge ?? data.checkout);
  try {
    switch (event.type) {
      case 'subscription_checkout.completed':
      case 'subscription.checkout.completed':
        await processCheckoutCompleted(data, occurredAt);
        break;
      case 'subscription_checkout.created':
      case 'subscription.checkout.created':
        processCheckoutStatus(object, 'pending', occurredAt);
        break;
      case 'subscription.charge_succeeded':
      case 'subscription.charge.succeeded':
        await processChargeSucceeded(object, occurredAt, event.id);
        break;
      case 'subscription.charge_failed':
      case 'subscription.charge.failed':
        await processChargeFailed(object, occurredAt, event.id);
        break;
      case 'subscription.cancelled':
      case 'subscription.canceled':
        processSubscriptionCancelled(object, occurredAt);
        break;
      case 'subscription.flagged':
        processSubscriptionFlagged(object, occurredAt);
        break;
      case 'subscription_checkout.expired':
      case 'subscription.checkout.expired':
        processCheckoutStatus(object, 'expired', occurredAt);
        break;
      case 'subscription_checkout.cancelled':
      case 'subscription.checkout.cancelled':
        processCheckoutStatus(object, 'cancelled', occurredAt);
        break;
    }
    recordBillingEvent({ provider: 'exodus', eventId: event.id, occurredAt, processedAt: new Date().toISOString() });
    recordAudit('exodus', 'billing.webhook', event.id, event.type);
  } catch (error) {
    log.error('Exodus webhook processing failed', { eventId: event.id, eventType: event.type, error: String(error) });
    throw error;
  }
}

export function verifyExodusEvent(rawBody: Buffer | string, signature: string, previousSignature = ''): boolean {
  return verifyExodusWebhookWithRotation(rawBody, signature, previousSignature);
}

export async function reconcileCryptoBilling(): Promise<void> {
  if (!exodusConfigured) return;
  const providerStatus = await getExodusProviderStatus();
  if (!providerStatus.ready) return;
  const client = new ExodusClient();
  const now = Date.now();
  for (const subscription of listBillingSubscriptions().filter((item) => item.provider === 'exodus' && item.userId)) {
    if (subscription.status === 'cancelled') continue;
    if (subscription.graceUntil && Date.parse(subscription.graceUntil) <= now) {
      await markSubscriptionCancelled(subscription, 'renewal grace period expired');
      continue;
    }
    if (!subscription.nextBilledAt || Date.parse(subscription.nextBilledAt) > now) continue;
    let attemptedNonce: number | undefined;
    try {
      const remote = await client.getSubscription(subscription.subscriptionId);
      if (remote.status === 'cancelled' || remote.status === 'canceled') {
        processSubscriptionCancelled({ id: remote.id }, new Date().toISOString());
        continue;
      }
      const remoteNextBilledAt = remote.next_charge_at ?? remote.next_charge_time;
      if (remoteNextBilledAt && Date.parse(remoteNextBilledAt) > now) {
        const reconciledAt = new Date().toISOString();
        upsertBillingSubscription({
          ...subscription,
          status: subscription.flagged ? 'past_due' : remote.status ?? subscription.status,
          nextBilledAt: remoteNextBilledAt,
          occurredAt: reconciledAt,
          updatedAt: reconciledAt,
        });
        continue;
      }
      const nonce = remote.charge_nonce;
      attemptedNonce = nonce;
      const existing = getBillingChargeForNonce(subscription.subscriptionId, nonce);
      if (existing?.status === 'succeeded') continue;
      if (existing?.retryAt && Date.parse(existing.retryAt) > now) continue;
      const chargeId = existing?.chargeId ?? `exodus:${subscription.subscriptionId}:${nonce}`;
      upsertBillingCharge({
        provider: 'exodus',
        chargeId,
        subscriptionId: subscription.subscriptionId,
        userId: subscription.userId!,
        status: 'pending',
        amount: subscription.amount ?? 0,
        currency: subscription.currency ?? config.exodusSettlementCurrency,
        asset: remote.token_symbol ?? remote.asset,
        chain: remote.chain,
        chargeNonce: nonce,
        retryAt: new Date(now + CHARGE_RETRY_INTERVAL_MS).toISOString(),
        occurredAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const quote = await client.getChargeQuote(subscription.subscriptionId);
      await client.chargeSubscription(remote, quote);
      const confirmed = await client.getSubscription(subscription.subscriptionId);
      if (confirmed.last_charge_status === 'succeeded' || confirmed.charge_nonce > nonce) {
        await processChargeSucceeded({ subscription: confirmed, id: confirmed.last_charge_id ?? chargeId }, new Date().toISOString(), chargeId);
      } else if (confirmed.last_charge_status === 'failed') {
        await processChargeFailed({ ...confirmed, subscription_id: confirmed.id, subscription_charge_id: confirmed.last_charge_id ?? chargeId, failure_reason: confirmed.failure_reason }, new Date().toISOString(), chargeId);
      }
    } catch (error) {
      const retryAt = new Date(now + CHARGE_RETRY_INTERVAL_MS).toISOString();
      const existing = getBillingChargeForNonce(subscription.subscriptionId, attemptedNonce ?? remoteNonce(subscription));
      if (existing) upsertBillingCharge({ ...existing, status: 'pending', retryAt, updatedAt: new Date().toISOString() });
      await markSubscriptionPastDue(subscription, error instanceof Error ? error.message : 'charge attempt failed');
      log.warn('Exodus billing reconciliation failed', { subscriptionId: subscription.subscriptionId, error: String(error) });
    }
  }
}

export function startCryptoBillingPoller(): void {
  if (!exodusConfigured) return;
  const interval = Math.max(60, config.cryptoBillingPollIntervalSeconds) * 1000;
  setInterval(() => void reconcileCryptoBilling(), interval).unref();
}

export function listManagerBillingSubscriptions(filters: { query?: string; provider?: string; status?: string } = {}): Array<Record<string, unknown>> {
  const profiles = new Map(
    [...new Set(listBillingSubscriptions().map((subscription) => subscription.userId).filter((userId): userId is string => !!userId))].map((userId) => [userId, getAuthProfile(userId)]),
  );
  const charges = listBillingCharges();
  const query = filters.query?.trim().toLowerCase();
  return listBillingSubscriptions()
    .filter((subscription) => !filters.provider || subscription.provider === filters.provider)
    .filter((subscription) => !filters.status || subscription.status === filters.status)
    .filter((subscription) => {
      if (!query) return true;
      const profile = subscription.userId ? profiles.get(subscription.userId) : undefined;
      return [subscription.userId, profile?.displayName, profile?.username, profile?.email, subscription.subscriptionId, subscription.planId, subscription.provider].some((value) => value?.toLowerCase().includes(query));
    })
    .map((subscription) => {
      const profile = subscription.userId ? profiles.get(subscription.userId) : undefined;
      return {
        user: subscription.userId
          ? {
              id: subscription.userId,
              displayName: profile?.displayName ?? subscription.userId,
              username: profile?.username,
              email: profile?.email,
            }
          : undefined,
        provider: subscription.provider,
        subscriptionId: subscription.subscriptionId,
        checkoutId: subscription.checkoutId,
        customerId: subscription.customerId,
        priceId: subscription.priceId,
        productId: subscription.productId,
        interval: subscription.interval,
        plan: { id: subscription.planId, name: getPlan(subscription.planId)?.name, amount: subscription.amount ?? getPlan(subscription.planId)?.amount, currency: subscription.currency ?? getPlan(subscription.planId)?.currency },
        status: subscription.status,
        nextBilledAt: subscription.nextBilledAt,
        occurredAt: subscription.occurredAt,
        updatedAt: subscription.updatedAt,
        crypto: subscription.provider === 'exodus' ? { walletAddress: subscription.walletAddress, chain: subscription.chain, asset: subscription.asset } : undefined,
        tax: subscription.taxStatus
          ? { status: subscription.taxStatus, country: subscription.taxAddress?.country, postalCode: subscription.taxAddress?.postalCode, transactionId: subscription.taxTransactionId }
          : undefined,
        lastCharge: {
          id: subscription.lastChargeId,
          status: subscription.lastChargeStatus,
          at: subscription.lastChargeAt,
          txHash: subscription.lastChargeTxHash,
          failureReason: subscription.failureReason,
          graceUntil: subscription.graceUntil,
          attempts: charges.filter((charge) => charge.subscriptionId === subscription.subscriptionId).slice(-10),
        },
      };
    });
}

function hasProcessedEvent(eventId: string): boolean {
  return eventId.length > 0 && hasProcessedBillingEvent(eventId);
}

async function processCheckoutCompleted(object: Record<string, unknown>, occurredAt: string): Promise<void> {
  const checkoutRecord = recordOf(object.object ?? object.checkout ?? object);
  const subscriptionRecord = recordOf(object.subscription ?? checkoutRecord.subscription ?? object);
  const checkoutId = stringValue(checkoutRecord.id ?? checkoutRecord.checkout_id);
  const localCheckout = checkoutId ? findCheckout(checkoutId) : undefined;
  const metadata = recordOf(checkoutRecord.metadata ?? subscriptionRecord.metadata);
  const userId = localCheckout?.userId ?? userIdFromMetadata(metadata) ?? userIdFromExternalCustomer(subscriptionRecord.external_customer_id ?? checkoutRecord.external_customer_id);
  const planId = localCheckout?.planId ?? planIdFromMetadata(metadata);
  const subscription = exodusSubscription(subscriptionRecord);
  if (!userId || !planId || !subscription) return;
  const existingSubscription = getBillingSubscriptionById(subscription.id);
  if (existingSubscription && Date.parse(existingSubscription.occurredAt) > Date.parse(occurredAt)) return;
  if (existingSubscription && localCheckout?.status === 'completed') return;
  if (!isSupportedExodusSubscription(subscription)) {
    if (localCheckout) upsertCryptoCheckout({ ...localCheckout, status: 'expired', updatedAt: occurredAt });
    recordAudit(userId, 'billing.webhook', checkoutId ?? subscription.id, 'unsupported Exodus asset or chain');
    log.warn('Exodus checkout used an unsupported asset or chain', { checkoutId, subscriptionId: subscription.id, asset: subscription.token_symbol ?? subscription.asset, chain: subscription.chain });
    return;
  }
  let taxTransactionId: string | undefined;
  let taxFailed = false;
  if (localCheckout?.taxCalculationId) {
    try {
      taxTransactionId = await recordCryptoTaxTransaction({
        calculationId: localCheckout.taxCalculationId,
        reference: `dkrypt:${subscription.id}:initial`,
        metadata: { user_id: userId, plan_id: planId, provider: 'exodus' },
      });
    } catch (error) {
      taxFailed = true;
      log.error('crypto tax transaction failed', { subscriptionId: subscription.id, error: String(error) });
    }
  }
  const charge = recordOf(object.first_charge ?? object.charge);
  const chargeId = stringValue(charge.id ?? charge.charge_id);
  const localSubscription = subscriptionFromResponse(subscription, {
    userId,
    planId,
    checkoutId,
    taxAddress: localCheckout?.taxAddress,
    taxStatus: localCheckout?.taxCalculationId ? (taxFailed ? 'failed' : 'recorded') : 'not_required',
    taxTransactionId,
    occurredAt,
  });
  const subscriptionWithCharge = chargeId
    ? {
        ...localSubscription,
        lastChargeAt: stringValue(charge.charged_at) ?? occurredAt,
        lastChargeId: chargeId,
        lastChargeStatus: 'succeeded' as const,
        lastChargeTxHash: stringValue(charge.tx_hash ?? charge.transaction_hash),
      }
    : localSubscription;
  const applied = upsertBillingSubscription(taxFailed ? { ...subscriptionWithCharge, flagged: true } : subscriptionWithCharge);
  if (localCheckout) upsertCryptoCheckout({ ...localCheckout, status: 'completed', updatedAt: occurredAt });
  if (chargeId) upsertBillingCharge(chargeFromObject(charge, chargeId, subscription as unknown as Record<string, unknown>, userId, 'succeeded', occurredAt, taxTransactionId));
  if (!applied) return;
  recordAudit(userId, 'billing.activated', subscription.id, `exodus ${planId}`);
  await notify('cryptoBillingSuccess', {
    title: taxFailed ? 'Crypto subscription needs review' : 'Crypto subscription active',
    description: taxFailed ? 'Your payment was received, but tax recording needs administrator attention.' : `Your ${planId} crypto subscription is active.`,
    color: taxFailed ? EMBED_COLOR.warn : EMBED_COLOR.ok,
  });
}

async function processChargeSucceeded(object: Record<string, unknown>, occurredAt: string, fallbackChargeId: string): Promise<void> {
  const subscriptionRecord = recordOf(object.subscription ?? object);
  const subscriptionId = stringValue(subscriptionRecord.id ?? object.subscription_id);
  if (!subscriptionId) return;
  const local = getBillingSubscriptionById(subscriptionId);
  if (!local || local.provider !== 'exodus' || !local.userId) return;
  if (Date.parse(local.occurredAt) > Date.parse(occurredAt)) return;
  const remote = exodusSubscription(subscriptionRecord);
  if (remote && !isSupportedExodusSubscription(remote)) {
    await markSubscriptionPastDue(local, 'Exodus reported an unsupported asset or chain');
    return;
  }
  const chargeId = stringValue(object.subscription_charge_id ?? object.charge_id ?? object.last_charge_id) ?? fallbackChargeId;
  if (local.lastChargeId === chargeId && local.lastChargeStatus === 'succeeded') return;
  let taxTransactionId = local.taxTransactionId;
  let taxFailed = false;
  if (local.taxAddress && local.amount) {
    try {
      const tax = await calculateCryptoTax({ amount: local.amount, planId: local.planId, address: local.taxAddress, idempotencyKey: `dkrypt-tax-charge-${chargeId}` });
      taxTransactionId = tax.calculationId
        ? await recordCryptoTaxTransaction({ calculationId: tax.calculationId, reference: `dkrypt:${subscriptionId}:${chargeId}`, metadata: { user_id: local.userId, plan_id: local.planId, provider: 'exodus' } })
        : taxTransactionId;
    } catch (error) {
      taxFailed = true;
      log.error('crypto recurring tax transaction failed', { subscriptionId, error: String(error) });
    }
  }
  const next = remote
    ? subscriptionFromResponse(remote, {
        userId: local.userId,
        planId: local.planId,
        checkoutId: local.checkoutId,
        taxAddress: local.taxAddress,
        taxStatus: local.taxAddress && local.amount ? (taxFailed ? 'failed' : 'recorded') : local.taxStatus ?? 'not_required',
        taxTransactionId,
        occurredAt,
    })
    : local;
  const chargeTxHash = stringValue(object.tx_hash ?? object.transaction_hash);
  const applied = upsertBillingSubscription({
    ...next,
    status: taxFailed ? 'past_due' : 'active',
    flagged: taxFailed,
    lastChargeAt: occurredAt,
    lastChargeId: chargeId,
    lastChargeStatus: taxFailed ? 'failed' : 'succeeded',
    lastChargeTxHash: chargeTxHash ?? next.lastChargeTxHash,
    failureReason: taxFailed ? 'tax transaction failed' : undefined,
    graceUntil: taxFailed ? new Date(Date.parse(occurredAt) + config.cryptoDunningGraceHours * 60 * 60 * 1000).toISOString() : undefined,
  });
  upsertBillingCharge(chargeFromObject(recordOf(object.charge ?? object), chargeId, (remote ?? subscriptionRecord) as unknown as Record<string, unknown>, local.userId, taxFailed ? 'failed' : 'succeeded', occurredAt, taxTransactionId));
  if (!applied) return;
  recordAudit(local.userId, 'billing.charge', subscriptionId, taxFailed ? 'crypto charge succeeded but tax transaction failed' : 'crypto charge succeeded');
  await notify(taxFailed ? 'cryptoBillingFailure' : 'cryptoBillingSuccess', {
    title: taxFailed ? 'Crypto billing needs review' : 'Crypto payment received',
    description: taxFailed ? 'A crypto renewal was received but tax recording needs administrator attention.' : `Your ${local.planId} crypto renewal was received.`,
    color: taxFailed ? EMBED_COLOR.warn : EMBED_COLOR.ok,
  });
}

async function processChargeFailed(object: Record<string, unknown>, occurredAt: string, fallbackChargeId: string): Promise<void> {
  const subscriptionId = stringValue(object.subscription_id ?? recordOf(object.subscription).id ?? object.id);
  if (!subscriptionId) return;
  const local = getBillingSubscriptionById(subscriptionId);
  if (!local || local.provider !== 'exodus' || !local.userId) return;
  if (Date.parse(local.occurredAt) > Date.parse(occurredAt)) return;
  const chargeId = stringValue(object.subscription_charge_id ?? object.charge_id) ?? fallbackChargeId;
  if (local.lastChargeId === chargeId && local.lastChargeStatus === 'failed') return;
  const retryAt = new Date(Date.parse(occurredAt) + CHARGE_RETRY_INTERVAL_MS).toISOString();
  const graceUntil = new Date(Date.parse(occurredAt) + config.cryptoDunningGraceHours * 60 * 60 * 1000).toISOString();
  const failureReason = stringValue(object.failure_reason ?? object.reason ?? object.error) ?? 'crypto renewal failed';
  const applied = upsertBillingSubscription({ ...local, status: 'past_due', lastChargeAt: occurredAt, lastChargeId: chargeId, lastChargeStatus: 'failed', failureReason, graceUntil, occurredAt, updatedAt: occurredAt });
  if (!applied) return;
  upsertBillingCharge(chargeFromObject(object, chargeId, object, local.userId, 'failed', occurredAt, undefined, retryAt, failureReason));
  recordAudit(local.userId, 'billing.charge-failed', subscriptionId, failureReason);
  await notify('cryptoBillingFailure', {
    title: 'Crypto renewal failed',
    description: `Your crypto renewal failed. dkrypt will retry it during the ${config.cryptoDunningGraceHours}-hour grace period.`,
    color: EMBED_COLOR.warn,
  });
}

function processSubscriptionCancelled(object: Record<string, unknown>, occurredAt: string): void {
  const subscriptionId = stringValue(object.id ?? object.subscription_id ?? recordOf(object.subscription).id);
  if (!subscriptionId) return;
  const local = getBillingSubscriptionById(subscriptionId);
  if (!local) return;
  const applied = upsertBillingSubscription({ ...local, status: 'cancelled', nextBilledAt: undefined, graceUntil: undefined, occurredAt, updatedAt: occurredAt });
  if (applied && local.userId) recordAudit(local.userId, 'billing.cancel', subscriptionId, 'Exodus reported cancellation');
}

function processSubscriptionFlagged(object: Record<string, unknown>, occurredAt: string): void {
  const subscriptionId = stringValue(object.id ?? object.subscription_id ?? recordOf(object.subscription).id);
  if (!subscriptionId) return;
  const local = getBillingSubscriptionById(subscriptionId);
  if (!local) return;
  upsertBillingSubscription({ ...local, flagged: true, status: 'past_due', failureReason: stringValue(object.reason) ?? 'Exodus flagged the subscription', occurredAt, updatedAt: occurredAt });
}

function processCheckoutStatus(object: Record<string, unknown>, status: BillingCheckout['status'], occurredAt: string): void {
  const checkoutId = stringValue(object.id ?? object.checkout_id);
  if (!checkoutId) return;
  const local = findCheckout(checkoutId);
  if (local) upsertCryptoCheckout({ ...local, status, updatedAt: occurredAt });
}

async function markSubscriptionPastDue(subscription: BillingSubscription, reason: string): Promise<void> {
  const now = new Date().toISOString();
  const graceUntil = subscription.graceUntil && Date.parse(subscription.graceUntil) > Date.now()
    ? subscription.graceUntil
    : new Date(Date.now() + config.cryptoDunningGraceHours * 60 * 60 * 1000).toISOString();
  upsertBillingSubscription({ ...subscription, status: 'past_due', failureReason: reason, graceUntil, occurredAt: now, updatedAt: now });
  if (subscription.userId) recordAudit(subscription.userId, 'billing.charge-failed', subscription.subscriptionId, reason);
}

async function markSubscriptionCancelled(subscription: BillingSubscription, reason: string): Promise<void> {
  const now = new Date().toISOString();
  upsertBillingSubscription({ ...subscription, status: 'cancelled', nextBilledAt: undefined, failureReason: reason, occurredAt: now, updatedAt: now });
  if (subscription.userId) recordAudit(subscription.userId, 'billing.cancel', subscription.subscriptionId, reason);
}

function findCheckout(checkoutId: string): BillingCheckout | undefined {
  return getCryptoCheckout(checkoutId);
}

function remoteNonce(subscription: BillingSubscription): number {
  const charge = listBillingCharges().filter((item) => item.subscriptionId === subscription.subscriptionId).at(-1);
  return charge?.chargeNonce ?? 0;
}

function eventDate(value: string | number | undefined): string {
  if (typeof value === 'number') return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function userIdFromMetadata(metadata: Record<string, unknown>): string | undefined {
  return stringValue(metadata.dkrypt_user_id);
}

function userIdFromExternalCustomer(value: unknown): string | undefined {
  const external = stringValue(value);
  return external?.startsWith('dkrypt:') ? external.slice('dkrypt:'.length) : undefined;
}

function planIdFromMetadata(metadata: Record<string, unknown>): Exclude<PlanId, 'viewer'> | undefined {
  const value = stringValue(metadata.plan_id);
  return value && getPlan(value) ? (value as Exclude<PlanId, 'viewer'>) : undefined;
}

function exodusSubscription(value: Record<string, unknown>): ExodusSubscription | undefined {
  const id = stringValue(value.id);
  const chargeNonce = typeof value.charge_nonce === 'number' ? value.charge_nonce : Number(value.charge_nonce);
  const manager = stringValue(value.subscription_manager_address);
  const chain = stringValue(value.chain);
  if (!id || !Number.isFinite(chargeNonce) || !manager || !chain) return undefined;
  return value as unknown as ExodusSubscription;
}

function chargeFromObject(
  object: Record<string, unknown>,
  chargeId: string,
  subscription: Record<string, unknown>,
  userId: string,
  status: BillingCharge['status'],
  occurredAt: string,
  taxTransactionId?: string,
  retryAt?: string,
  failureReason?: string,
): BillingCharge {
  const currency = stringValue(subscription.price_currency ?? object.price_currency);
  const fiatAmountMinor = numberValue(subscription.price ?? subscription.charge_amount ?? object.price ?? object.fiat_amount);
  const amount = currency && fiatAmountMinor !== undefined
    ? fiatAmountMinor / 100
    : numberValue(object.amount ?? object.charge_amount) ?? fiatAmountMinor ?? 0;
  const nonce = numberValue(subscription.charge_nonce);
  return {
    provider: 'exodus',
    chargeId,
    subscriptionId: stringValue(subscription.id) ?? '',
    userId,
    status,
    amount,
    currency: currency ?? config.exodusSettlementCurrency,
    tokenAmount: stringValue(object.token_amount ?? object.amount ?? object.charge_amount),
    asset: stringValue(object.token_symbol ?? object.asset ?? subscription.token_symbol ?? subscription.asset),
    chain: stringValue(object.chain ?? subscription.chain),
    txHash: stringValue(object.tx_hash ?? object.transaction_hash),
    chargeNonce: nonce,
    taxTransactionId,
    failureReason,
    retryAt,
    occurredAt,
    updatedAt: occurredAt,
  };
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}
