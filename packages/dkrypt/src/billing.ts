import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openStateCollectionDatabase, readStateCollection, replaceStateCollection } from '#store/sqlite.js';
import { config } from '#config.js';
import { hasPermission, PermissionFlag } from '#permissions.js';

export type BillingProvider = 'stripe' | 'nowpayments' | 'legacy';
export type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api';
export type BillingChargeStatus = 'pending' | 'succeeded' | 'failed';
export type BillingCheckoutStatus = 'pending' | 'completed' | 'expired' | 'cancelled';
export type BillingTaxStatus = 'not_required' | 'pending' | 'recorded' | 'failed';

export interface BillingTaxAddress {
  country: string;
  state?: string;
  postalCode: string;
  city?: string;
  line1?: string;
  line2?: string;
}

export interface BillingCustomer {
  provider: BillingProvider;
  customerId: string;
  email: string;
  userId?: string;
  updatedAt: string;
}

export interface BillingSubscription {
  provider: BillingProvider;
  subscriptionId: string;
  customerId: string;
  userId?: string;
  status: string;
  planId: Exclude<PlanId, 'viewer'>;
  priceId: string;
  productId: string;
  subscriptionItemId?: string;
  checkoutId?: string;
  externalCustomerId?: string;
  currency?: string;
  amount?: number;
  interval?: string;
  walletAddress?: string;
  chain?: string;
  asset?: string;
  providerPaymentId?: string;
  nextBilledAt?: string;
  scheduledChangeAction?: string;
  scheduledChangeAt?: string;
  lastChargeAt?: string;
  lastChargeId?: string;
  lastChargeStatus?: BillingChargeStatus;
  lastChargeTxHash?: string;
  failureReason?: string;
  graceUntil?: string;
  paused?: boolean;
  flagged?: boolean;
  taxAddress?: BillingTaxAddress;
  taxStatus?: BillingTaxStatus;
  taxTransactionId?: string;
  occurredAt: string;
  updatedAt: string;
}

export interface BillingCheckout {
  provider: 'nowpayments' | 'legacy';
  checkoutId: string;
  providerCheckoutId?: string;
  providerPaymentId?: string;
  orderId?: string;
  userId: string;
  idempotencyKey: string;
  planId: Exclude<PlanId, 'viewer'>;
  amount: number;
  currency: string;
  status: BillingCheckoutStatus;
  checkoutUrl: string;
  asset?: string;
  taxAddress?: BillingTaxAddress;
  taxCalculationId?: string;
  taxStatus?: BillingTaxStatus;
  createdAt: string;
  updatedAt: string;
}

export interface BillingCharge {
  provider: 'nowpayments' | 'legacy';
  chargeId: string;
  subscriptionId: string;
  userId: string;
  status: BillingChargeStatus;
  amount: number;
  currency: string;
  tokenAmount?: string;
  asset?: string;
  chain?: string;
  txHash?: string;
  chargeNonce?: number;
  taxTransactionId?: string;
  failureReason?: string;
  retryAt?: string;
  occurredAt: string;
  updatedAt: string;
}

export interface BillingEventRecord {
  provider: 'nowpayments' | 'legacy';
  eventId: string;
  occurredAt: string;
  processedAt: string;
}

export interface BillingEntitlementEvent {
  id: string;
  userId?: string;
  subscriptionId: string;
  provider: BillingProvider;
  planId: Exclude<PlanId, 'viewer'>;
  kind: 'grant' | 'renewal' | 'pause' | 'failure' | 'cancellation' | 'revocation';
  status: string;
  at: string;
  detail?: string;
}

export interface BillingSnapshot {
  customers: BillingCustomer[];
  subscriptions: BillingSubscription[];
  cryptoCheckouts: BillingCheckout[];
  cryptoCharges: BillingCharge[];
  processedEvents: BillingEventRecord[];
  entitlementHistory?: BillingEntitlementEvent[];
}

export interface BillingEntitlements {
  planId: PlanId;
  decrypt: boolean;
  api: boolean;
  priority: number;
  provider?: BillingProvider;
  status?: string;
  subscriptionId?: string;
  nextBilledAt?: string;
  scheduledChangeAction?: string;
  scheduledChangeAt?: string;
}

const planDefinitions = [
  {
    id: 'regular',
    name: 'Regular',
    description: 'Dashboard decrypt access with standard queue priority.',
    amount: 5,
    currency: 'EUR',
    priceId: config.stripeRegularPriceId,
    decrypt: true,
    api: false,
    priority: 0,
  },
  {
    id: 'priority',
    name: 'Priority',
    description: 'Dashboard decrypt access with high queue priority.',
    amount: 10,
    currency: 'EUR',
    priceId: config.stripePriorityPriceId,
    decrypt: true,
    api: false,
    priority: 5,
  },
  {
    id: 'api',
    name: 'API',
    description: 'Dashboard decrypts and API key access with standard priority.',
    amount: 15,
    currency: 'EUR',
    priceId: config.stripeApiPriceId,
    decrypt: true,
    api: true,
    priority: 0,
  },
  {
    id: 'priority_api',
    name: 'Priority API',
    description: 'Dashboard decrypts and API key access with high queue priority.',
    amount: 20,
    currency: 'EUR',
    priceId: config.stripePriorityApiPriceId,
    decrypt: true,
    api: true,
    priority: 5,
  },
] as const;

const billingPath = path.join(config.stateDir, 'billing.json');
const billingDatabase = openStateCollectionDatabase({ stateDir: config.stateDir, filename: config.stateDatabaseFile, busyTimeoutMs: config.stateDbBusyTimeoutMs }, ['billing_records', 'billing_events']);
const stripeActiveStatuses = new Set(['active', 'trialing', 'past_due']);
const checkoutLocks = new Set<string>();
let loadedFromLegacyFile = false;

function emptySnapshot(): BillingSnapshot {
  return { customers: [], subscriptions: [], cryptoCheckouts: [], cryptoCharges: [], processedEvents: [], entitlementHistory: [] };
}

function load(): BillingSnapshot {
  mkdirSync(config.stateDir, { recursive: true });
  const records = readStateCollection(billingDatabase, 'billing_records');
  if (records.length > 0) {
    const record = records[0];
    if (typeof record !== 'object' || record === null || (record as { kind?: unknown }).kind !== 'snapshot') throw new Error('billing database record is malformed');
    const snapshot = normalizeBillingSnapshot((record as { value?: unknown }).value);
    if (!snapshot) throw new Error('billing database snapshot is malformed');
    return snapshot;
  }
  if (!existsSync(billingPath)) return emptySnapshot();
  try {
    const snapshot = normalizeBillingSnapshot(JSON.parse(readFileSync(billingPath, 'utf8')));
    if (!snapshot) throw new Error('billing JSON snapshot is malformed');
    loadedFromLegacyFile = true;
    return snapshot;
  } catch (error) {
    throw new Error(`could not initialize billing state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const state = load();
if (loadedFromLegacyFile) persist();

function persist(): void {
  replaceStateCollection(billingDatabase, 'billing_records', [{ id: 'billing-snapshot', payload: { kind: 'snapshot', value: state }, updatedAt: Date.now() }]);
  replaceStateCollection(billingDatabase, 'billing_events', state.processedEvents.map((event) => ({ id: `${event.provider}:${event.eventId}`, payload: event, updatedAt: Date.parse(event.processedAt) || Date.now() })));
  const temporaryPath = `${billingPath}.${process.pid}.tmp`;
  mkdirSync(path.dirname(billingPath), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  const descriptor = openSync(temporaryPath, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, billingPath);
}

export function closeBillingDatabase(): void {
  billingDatabase.close();
}

export function listPlans() {
  return planDefinitions.map(({ decrypt: _decrypt, api: _api, priority: _priority, ...plan }) => plan);
}

export function getPlan(planId: string) {
  return planDefinitions.find((plan) => plan.id === planId);
}

export function planForPrice(priceId: string): Exclude<PlanId, 'viewer'> | undefined {
  return planDefinitions.find((plan) => plan.priceId === priceId)?.id;
}

export function isBillingSubscriptionActive(subscription: BillingSubscription, now = Date.now()): boolean {
  if (subscription.provider === 'stripe') return stripeActiveStatuses.has(subscription.status);
  if (subscription.provider !== 'nowpayments') return false;
  if (subscription.status === 'active' && !subscription.flagged && !subscription.paused) return true;
  return subscription.status === 'past_due' && !!subscription.graceUntil && Date.parse(subscription.graceUntil) > now;
}

export function upsertBillingCustomer(customer: BillingCustomer): void {
  const existing = state.customers.find((item) => item.provider === customer.provider && item.customerId === customer.customerId);
  if (existing) Object.assign(existing, customer, { userId: customer.userId ?? existing.userId });
  else state.customers.push(customer);

  if (customer.userId) {
    for (const subscription of state.subscriptions) {
      if (subscription.provider === customer.provider && subscription.customerId === customer.customerId && !subscription.userId) subscription.userId = customer.userId;
    }
  }
  persist();
}

export function linkBillingCustomer(customerId: string, userId: string): void {
  const existing = state.customers.find((item) => item.provider === 'stripe' && item.customerId === customerId);
  if (existing) existing.userId = userId;
  else state.customers.push({ provider: 'stripe', customerId, email: '', userId, updatedAt: new Date().toISOString() });
  for (const subscription of state.subscriptions) {
    if (subscription.provider === 'stripe' && subscription.customerId === customerId && !subscription.userId) subscription.userId = userId;
  }
  persist();
}

export function upsertBillingSubscription(subscription: BillingSubscription): boolean {
  const existing = state.subscriptions.find((item) => item.provider === subscription.provider && item.subscriptionId === subscription.subscriptionId);
  if (existing && Date.parse(existing.occurredAt) > Date.parse(subscription.occurredAt)) return false;
  const previous = existing ? { ...existing } : undefined;
  if (existing) Object.assign(existing, subscription, { userId: subscription.userId ?? existing.userId });
  else {
    const customer = state.customers.find((item) => item.provider === subscription.provider && item.customerId === subscription.customerId);
    state.subscriptions.push({ ...subscription, userId: subscription.userId ?? customer?.userId });
  }
  const kind = entitlementEventKind(previous, subscription);
  if (kind) {
    state.entitlementHistory = [
      ...(state.entitlementHistory ?? []),
      { id: `${subscription.subscriptionId}:${subscription.updatedAt}:${kind}`, userId: subscription.userId ?? previous?.userId, subscriptionId: subscription.subscriptionId, provider: subscription.provider, planId: subscription.planId, kind, status: subscription.status, at: subscription.updatedAt, detail: subscription.failureReason },
    ].slice(-5000);
  }
  persist();
  return true;
}

export function getBillingCustomerId(userId: string): string | undefined {
  return state.customers.find((customer) => customer.provider === 'stripe' && customer.userId === userId)?.customerId;
}

export function getBillingUserId(customerId: string): string | undefined {
  return state.customers.find((customer) => customer.provider === 'stripe' && customer.customerId === customerId)?.userId;
}

export function getBillingSubscription(userId: string, subscriptionId: string): BillingSubscription | undefined {
  return state.subscriptions.find((subscription) => subscription.userId === userId && subscription.subscriptionId === subscriptionId);
}

export function getBillingSubscriptionById(subscriptionId: string): BillingSubscription | undefined {
  return state.subscriptions.find((subscription) => subscription.subscriptionId === subscriptionId);
}

export function getBillingSubscriptionIds(userId: string): string[] {
  return state.subscriptions
    .filter((subscription) => subscription.userId === userId && isBillingSubscriptionActive(subscription))
    .map((subscription) => subscription.subscriptionId);
}

export function getBillingSubscriptionsForUser(userId: string): BillingSubscription[] {
  return state.subscriptions.filter((subscription) => subscription.userId === userId).map((subscription) => structuredClone(subscription));
}

export function listBillingSubscriptions(): BillingSubscription[] {
  return state.subscriptions.map((subscription) => structuredClone(subscription));
}

export function listBillingEntitlementHistory(subscriptionId?: string): BillingEntitlementEvent[] {
  return (state.entitlementHistory ?? [])
    .filter((event) => !subscriptionId || event.subscriptionId === subscriptionId)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .map((event) => structuredClone(event));
}

export function getBillingEntitlements(userId: string): BillingEntitlements {
  return resolveBillingEntitlements(state.subscriptions.filter((subscription) => subscription.userId === userId));
}

export function hasActiveBillingSubscription(userId: string): boolean {
  return state.subscriptions.some((subscription) => subscription.userId === userId && isBillingSubscriptionActive(subscription));
}

export function acquireBillingCheckoutLock(userId: string): boolean {
  if (checkoutLocks.has(userId)) return false;
  checkoutLocks.add(userId);
  return true;
}

export function releaseBillingCheckoutLock(userId: string): void {
  checkoutLocks.delete(userId);
}

export function hasLegacyBillingRecord(userId: string): boolean {
  return (
    state.customers.some((customer) => customer.provider === 'legacy' && customer.userId === userId) ||
    state.subscriptions.some((subscription) => subscription.provider === 'legacy' && subscription.userId === userId)
  );
}

export function canCreateApiKeyImmediately(permissions: bigint, entitlements: BillingEntitlements): boolean {
  return hasPermission(permissions, PermissionFlag.approveApiKeys) || entitlements.api;
}

export function mergeBillingAccounts(targetUserId: string, sourceUserId: string): void {
  if (targetUserId === sourceUserId) return;
  let changed = false;
  for (const customer of state.customers) {
    if (customer.userId === sourceUserId) {
      customer.userId = targetUserId;
      changed = true;
    }
  }
  for (const subscription of state.subscriptions) {
    if (subscription.userId === sourceUserId) {
      subscription.userId = targetUserId;
      changed = true;
    }
  }
  for (const checkout of state.cryptoCheckouts) {
    if (checkout.userId === sourceUserId) {
      checkout.userId = targetUserId;
      changed = true;
    }
  }
  for (const charge of state.cryptoCharges) {
    if (charge.userId === sourceUserId) {
      charge.userId = targetUserId;
      changed = true;
    }
  }
  if (changed) persist();
}

export function resolveBillingEntitlements(subscriptions: BillingSubscription[]): BillingEntitlements {
  const activeSubscriptions = subscriptions.filter((subscription) => isBillingSubscriptionActive(subscription));
  if (activeSubscriptions.length === 0) return { planId: 'viewer', decrypt: false, api: false, priority: 0 };

  const definitions = activeSubscriptions
    .map((subscription) => ({
      subscription,
      definition: planDefinitions.find((plan) => plan.id === subscription.planId),
    }))
    .filter((entry): entry is { subscription: BillingSubscription; definition: (typeof planDefinitions)[number] } => !!entry.definition);

  const strongest = definitions.sort((a, b) => {
    const capabilityA = Number(a.definition.api) * 10 + a.definition.priority;
    const capabilityB = Number(b.definition.api) * 10 + b.definition.priority;
    return capabilityB - capabilityA;
  })[0];

  if (!strongest) return { planId: 'viewer', decrypt: false, api: false, priority: 0 };

  return {
    planId: strongest.definition.id,
    decrypt: definitions.some((entry) => entry.definition.decrypt),
    api: definitions.some((entry) => entry.definition.api),
    priority: Math.max(...definitions.map((entry) => entry.definition.priority)),
    provider: strongest.subscription.provider,
    status: strongest.subscription.status,
    subscriptionId: strongest.subscription.subscriptionId,
    nextBilledAt: strongest.subscription.nextBilledAt,
    scheduledChangeAction: strongest.subscription.scheduledChangeAction,
    scheduledChangeAt: strongest.subscription.scheduledChangeAt,
  };
}

export function findCryptoCheckout(userId: string, idempotencyKey: string): BillingCheckout | undefined {
  return state.cryptoCheckouts.find((checkout) => checkout.userId === userId && checkout.idempotencyKey === idempotencyKey);
}

export function getCryptoCheckout(checkoutId: string): BillingCheckout | undefined {
  return state.cryptoCheckouts.find((checkout) => checkout.checkoutId === checkoutId);
}

export function listCryptoCheckouts(): BillingCheckout[] {
  return state.cryptoCheckouts.map((checkout) => structuredClone(checkout));
}

export function upsertCryptoCheckout(checkout: BillingCheckout): void {
  const existing = state.cryptoCheckouts.find((item) => item.checkoutId === checkout.checkoutId);
  if (existing) {
    if (existing.status === 'completed' && checkout.status !== 'completed') return;
    if (checkout.status !== 'completed' && Date.parse(existing.updatedAt) > Date.parse(checkout.updatedAt)) return;
    Object.assign(existing, checkout);
  } else state.cryptoCheckouts.push(checkout);
  persist();
}

export function upsertBillingCharge(charge: BillingCharge): void {
  const existing = state.cryptoCharges.find((item) => item.chargeId === charge.chargeId);
  if (existing) {
    if (existing.status === 'succeeded' && charge.status !== 'succeeded') return;
    if (existing.status !== 'pending' && Date.parse(existing.occurredAt) > Date.parse(charge.occurredAt)) return;
    Object.assign(existing, charge);
  } else state.cryptoCharges.push(charge);
  if (state.cryptoCharges.length > 5000) state.cryptoCharges.splice(0, state.cryptoCharges.length - 5000);
  persist();
}

export function getBillingCharge(chargeId: string): BillingCharge | undefined {
  return state.cryptoCharges.find((charge) => charge.chargeId === chargeId);
}

export function getBillingChargeForNonce(subscriptionId: string, chargeNonce: number): BillingCharge | undefined {
  return state.cryptoCharges.find((charge) => charge.subscriptionId === subscriptionId && charge.chargeNonce === chargeNonce);
}

export function listBillingCharges(): BillingCharge[] {
  return state.cryptoCharges.map((charge) => structuredClone(charge));
}

export function hasProcessedBillingEvent(eventId: string): boolean {
  return state.processedEvents.some((event) => event.eventId === eventId);
}

export function recordBillingEvent(event: BillingEventRecord): void {
  if (!hasProcessedBillingEvent(event.eventId)) state.processedEvents.push(event);
  if (state.processedEvents.length > 5000) state.processedEvents.splice(0, state.processedEvents.length - 5000);
  persist();
}

export function exportBillingSnapshot(): BillingSnapshot {
  return structuredClone(state);
}

export function isBillingSnapshot(value: unknown): value is BillingSnapshot {
  return normalizeBillingSnapshot(value) !== undefined;
}

export function replaceBillingSnapshot(snapshot: BillingSnapshot): void;
export function replaceBillingSnapshot(snapshot: { customers: BillingCustomer[]; subscriptions: BillingSubscription[] }): void;
export function replaceBillingSnapshot(snapshot: BillingSnapshot | { customers: BillingCustomer[]; subscriptions: BillingSubscription[] }): void {
  const normalized = normalizeBillingSnapshot(snapshot);
  if (!normalized) throw new Error('billing snapshot is malformed');
  state.customers = normalized.customers;
  state.subscriptions = normalized.subscriptions;
  state.cryptoCheckouts = normalized.cryptoCheckouts;
  state.cryptoCharges = normalized.cryptoCharges;
  state.processedEvents = normalized.processedEvents;
  state.entitlementHistory = normalized.entitlementHistory ?? [];
  persist();
}

function entitlementEventKind(previous: BillingSubscription | undefined, next: BillingSubscription): BillingEntitlementEvent['kind'] | undefined {
  if (!previous) return 'grant';
  if (previous.status !== next.status) {
    if (next.status === 'cancelled' || next.status === 'canceled') return 'cancellation';
    if (next.status === 'past_due' || next.lastChargeStatus === 'failed') return 'failure';
    if (next.status === 'paused' || next.paused) return 'pause';
    if (next.status === 'active') return 'renewal';
    if (next.status === 'revoked') return 'revocation';
  }
  if (previous.lastChargeId !== next.lastChargeId && next.lastChargeStatus === 'succeeded') return 'renewal';
  return undefined;
}

function normalizeBillingSnapshot(value: unknown): BillingSnapshot | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const snapshot = value as Record<string, unknown>;
  if (!Array.isArray(snapshot.customers) || !Array.isArray(snapshot.subscriptions)) return undefined;

  const customers: BillingCustomer[] = [];
  for (const customer of snapshot.customers) {
    if (typeof customer !== 'object' || customer === null) return undefined;
    const record = customer as Record<string, unknown>;
    const provider = billingProvider(record.provider);
    if (!provider || typeof record.customerId !== 'string' || typeof record.email !== 'string' || typeof record.updatedAt !== 'string') return undefined;
    customers.push({
      provider,
      customerId: record.customerId,
      email: record.email,
      userId: optionalString(record.userId),
      updatedAt: record.updatedAt,
    });
  }

  const subscriptions: BillingSubscription[] = [];
  for (const subscription of snapshot.subscriptions) {
    if (typeof subscription !== 'object' || subscription === null) return undefined;
    const record = subscription as Record<string, unknown>;
    const provider = billingProvider(record.provider);
    if (
      !provider ||
      typeof record.subscriptionId !== 'string' ||
      typeof record.customerId !== 'string' ||
      typeof record.status !== 'string' ||
      typeof record.planId !== 'string' ||
      !planDefinitions.some((plan) => plan.id === record.planId) ||
      typeof record.priceId !== 'string' ||
      typeof record.productId !== 'string' ||
      typeof record.occurredAt !== 'string' ||
      typeof record.updatedAt !== 'string'
    ) return undefined;
    subscriptions.push({
      provider,
      subscriptionId: record.subscriptionId,
      customerId: record.customerId,
      userId: optionalString(record.userId),
      status: record.status,
      planId: record.planId as Exclude<PlanId, 'viewer'>,
      priceId: record.priceId,
      productId: record.productId,
      subscriptionItemId: optionalString(record.subscriptionItemId),
      checkoutId: optionalString(record.checkoutId),
      externalCustomerId: optionalString(record.externalCustomerId),
      currency: optionalString(record.currency),
      amount: optionalNumber(record.amount),
      interval: optionalString(record.interval),
      walletAddress: optionalString(record.walletAddress),
      chain: optionalString(record.chain),
      asset: optionalString(record.asset),
      providerPaymentId: optionalString(record.providerPaymentId),
      nextBilledAt: optionalString(record.nextBilledAt),
      scheduledChangeAction: optionalString(record.scheduledChangeAction),
      scheduledChangeAt: optionalString(record.scheduledChangeAt),
      lastChargeAt: optionalString(record.lastChargeAt),
      lastChargeId: optionalString(record.lastChargeId),
      lastChargeStatus: billingChargeStatus(record.lastChargeStatus),
      lastChargeTxHash: optionalString(record.lastChargeTxHash),
      failureReason: optionalString(record.failureReason),
      graceUntil: optionalString(record.graceUntil),
      paused: optionalBoolean(record.paused),
      flagged: optionalBoolean(record.flagged),
      taxAddress: taxAddress(record.taxAddress),
      taxStatus: billingTaxStatus(record.taxStatus),
      taxTransactionId: optionalString(record.taxTransactionId),
      occurredAt: record.occurredAt,
      updatedAt: record.updatedAt,
    });
  }

  return {
    customers,
    subscriptions,
    cryptoCheckouts: Array.isArray(snapshot.cryptoCheckouts) ? snapshot.cryptoCheckouts.filter(isBillingCheckout).map((item) => structuredClone(item)) : [],
    cryptoCharges: Array.isArray(snapshot.cryptoCharges) ? snapshot.cryptoCharges.filter(isBillingCharge).map((item) => structuredClone(item)) : [],
    processedEvents: Array.isArray(snapshot.processedEvents) ? snapshot.processedEvents.filter(isBillingEvent).map((item) => structuredClone(item)) : [],
    entitlementHistory: Array.isArray(snapshot.entitlementHistory) ? snapshot.entitlementHistory.filter(isEntitlementEvent).map((item) => structuredClone(item)) : [],
  };
}

function billingProvider(value: unknown): BillingProvider | undefined {
  if (value === undefined || value === 'legacy') return 'legacy';
  if (value === 'exodus') return 'legacy';
  return value === 'stripe' || value === 'nowpayments' ? value : undefined;
}

function billingChargeStatus(value: unknown): BillingChargeStatus | undefined {
  return value === 'pending' || value === 'succeeded' || value === 'failed' ? value : undefined;
}

function billingTaxStatus(value: unknown): BillingTaxStatus | undefined {
  return value === 'not_required' || value === 'pending' || value === 'recorded' || value === 'failed' ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function taxAddress(value: unknown): BillingTaxAddress | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.country !== 'string' || typeof record.postalCode !== 'string') return undefined;
  return {
    country: record.country,
    postalCode: record.postalCode,
    state: optionalString(record.state),
    city: optionalString(record.city),
    line1: optionalString(record.line1),
    line2: optionalString(record.line2),
  };
}

function isBillingCheckout(value: unknown): value is BillingCheckout {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === 'nowpayments' || record.provider === 'legacy') &&
    typeof record.checkoutId === 'string' &&
    typeof record.userId === 'string' &&
    typeof record.idempotencyKey === 'string' &&
    typeof record.planId === 'string' &&
    planDefinitions.some((plan) => plan.id === record.planId) &&
    typeof record.amount === 'number' &&
    typeof record.currency === 'string' &&
    typeof record.status === 'string' &&
    ['pending', 'completed', 'expired', 'cancelled'].includes(record.status) &&
    typeof record.checkoutUrl === 'string' &&
    (record.taxStatus === undefined || billingTaxStatus(record.taxStatus) !== undefined) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isBillingCharge(value: unknown): value is BillingCharge {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.provider === 'nowpayments' || record.provider === 'legacy') &&
    typeof record.chargeId === 'string' &&
    typeof record.subscriptionId === 'string' &&
    typeof record.userId === 'string' &&
    billingChargeStatus(record.status) !== undefined &&
    typeof record.amount === 'number' &&
    typeof record.currency === 'string' &&
    typeof record.occurredAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isBillingEvent(value: unknown): value is BillingEventRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (record.provider === 'nowpayments' || record.provider === 'legacy') && typeof record.eventId === 'string' && typeof record.occurredAt === 'string' && typeof record.processedAt === 'string';
}

function isEntitlementEvent(value: unknown): value is BillingEntitlementEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && typeof record.subscriptionId === 'string' && billingProvider(record.provider) !== undefined && typeof record.planId === 'string' && planDefinitions.some((plan) => plan.id === record.planId) && ['grant', 'renewal', 'pause', 'failure', 'cancellation', 'revocation'].includes(String(record.kind)) && typeof record.status === 'string' && typeof record.at === 'string';
}
