import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '#config.js';
import { hasPermission, PermissionFlag } from '#permissions.js';

export type BillingProvider = 'stripe' | 'legacy';
export type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api';

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
  nextBilledAt?: string;
  scheduledChangeAction?: string;
  scheduledChangeAt?: string;
  occurredAt: string;
  updatedAt: string;
}

export interface BillingSnapshot {
  customers: BillingCustomer[];
  subscriptions: BillingSubscription[];
}

export interface BillingEntitlements {
  planId: PlanId;
  decrypt: boolean;
  api: boolean;
  priority: number;
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
    description: 'Dashboard decrypts and API key access with high priority.',
    amount: 20,
    currency: 'EUR',
    priceId: config.stripePriorityApiPriceId,
    decrypt: true,
    api: true,
    priority: 5,
  },
] as const;

const billingPath = path.join(config.stateDir, 'billing.json');
const activeStatuses = new Set(['active', 'trialing', 'past_due']);

function load(): BillingSnapshot {
  mkdirSync(config.stateDir, { recursive: true });
  if (!existsSync(billingPath)) return { customers: [], subscriptions: [] };
  try {
    return normalizeBillingSnapshot(JSON.parse(readFileSync(billingPath, 'utf8'))) ?? { customers: [], subscriptions: [] };
  } catch {
    return { customers: [], subscriptions: [] };
  }
}

const state = load();

function persist(): void {
  writeFileSync(billingPath, JSON.stringify(state, null, 2));
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

export function upsertBillingCustomer(customer: BillingCustomer): void {
  const existing = state.customers.find((item) => item.customerId === customer.customerId);
  if (existing) Object.assign(existing, customer, { userId: customer.userId ?? existing.userId });
  else state.customers.push(customer);

  if (customer.userId) {
    for (const subscription of state.subscriptions) {
      if (subscription.customerId === customer.customerId && !subscription.userId) subscription.userId = customer.userId;
    }
  }
  persist();
}

export function linkBillingCustomer(customerId: string, userId: string): void {
  const existing = state.customers.find((item) => item.customerId === customerId);
  if (existing) existing.userId = userId;
  else state.customers.push({ provider: 'stripe', customerId, email: '', userId, updatedAt: new Date().toISOString() });
  for (const subscription of state.subscriptions) {
    if (subscription.customerId === customerId && !subscription.userId) subscription.userId = userId;
  }
  persist();
}

export function upsertBillingSubscription(subscription: BillingSubscription): void {
  const existing = state.subscriptions.find((item) => item.subscriptionId === subscription.subscriptionId);
  if (existing && Date.parse(existing.occurredAt) > Date.parse(subscription.occurredAt)) return;
  if (existing) Object.assign(existing, subscription, { userId: subscription.userId ?? existing.userId });
  else {
    const customer = state.customers.find((item) => item.customerId === subscription.customerId);
    state.subscriptions.push({ ...subscription, userId: subscription.userId ?? customer?.userId });
  }
  persist();
}

export function getBillingCustomerId(userId: string): string | undefined {
  return state.customers.find((customer) => customer.provider === 'stripe' && customer.userId === userId)?.customerId;
}

export function getBillingUserId(customerId: string): string | undefined {
  return state.customers.find((customer) => customer.provider === 'stripe' && customer.customerId === customerId)?.userId;
}

export function getBillingSubscription(userId: string, subscriptionId: string): BillingSubscription | undefined {
  return state.subscriptions.find(
    (subscription) => subscription.provider === 'stripe' && subscription.userId === userId && subscription.subscriptionId === subscriptionId,
  );
}

export function getBillingSubscriptionIds(userId: string): string[] {
  return state.subscriptions
    .filter((subscription) => subscription.provider === 'stripe' && subscription.userId === userId && activeStatuses.has(subscription.status))
    .map((subscription) => subscription.subscriptionId);
}

export function getBillingEntitlements(userId: string): BillingEntitlements {
  return resolveBillingEntitlements(
    state.subscriptions.filter((subscription) => subscription.provider === 'stripe' && subscription.userId === userId),
  );
}

export function hasLegacyBillingRecord(userId: string): boolean {
  return (
    state.customers.some((customer) => customer.provider === 'legacy' && customer.userId === userId) ||
    state.subscriptions.some((subscription) => subscription.provider === 'legacy' && subscription.userId === userId)
  );
}

export function canCreateApiKeyImmediately(
  permissions: bigint,
  entitlements: BillingEntitlements,
): boolean {
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
  if (changed) persist();
}

export function resolveBillingEntitlements(subscriptions: BillingSubscription[]): BillingEntitlements {
  const activeSubscriptions = subscriptions.filter(
    (subscription) => subscription.provider === 'stripe' && activeStatuses.has(subscription.status),
  );
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
    status: strongest.subscription.status,
    subscriptionId: strongest.subscription.subscriptionId,
    nextBilledAt: strongest.subscription.nextBilledAt,
    scheduledChangeAction: strongest.subscription.scheduledChangeAction,
    scheduledChangeAt: strongest.subscription.scheduledChangeAt,
  };
}

export function exportBillingSnapshot(): BillingSnapshot {
  return structuredClone(state);
}

export function isBillingSnapshot(value: unknown): value is BillingSnapshot {
  return normalizeBillingSnapshot(value) !== undefined;
}

export function replaceBillingSnapshot(snapshot: BillingSnapshot): void {
  const normalized = normalizeBillingSnapshot(snapshot);
  if (!normalized) throw new Error('billing snapshot is malformed');
  state.customers = normalized.customers;
  state.subscriptions = normalized.subscriptions;
  persist();
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
    if (!provider || typeof record.customerId !== 'string' || typeof record.email !== 'string' || typeof record.updatedAt !== 'string') {
      return undefined;
    }
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
    ) {
      return undefined;
    }
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
      nextBilledAt: optionalString(record.nextBilledAt),
      scheduledChangeAction: optionalString(record.scheduledChangeAction),
      scheduledChangeAt: optionalString(record.scheduledChangeAt),
      occurredAt: record.occurredAt,
      updatedAt: record.updatedAt,
    });
  }

  return { customers, subscriptions };
}

function billingProvider(value: unknown): BillingProvider | undefined {
  if (value === undefined || value === 'legacy') return 'legacy';
  return value === 'stripe' ? 'stripe' : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
