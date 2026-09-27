import type { Database } from 'bun:sqlite';
import type { BillingCharge, BillingCheckout, BillingCustomer, BillingEntitlementEvent, BillingEventRecord, BillingProvider, BillingSubscription } from '#billing.js';

export interface BillingSubscriptionFilter {
  userId?: string;
  query?: string;
  provider?: string;
  status?: string;
  planId?: string;
  from?: string;
  to?: string;
  wallet?: string;
  invoice?: string;
}

export interface BillingRepository {
  listCustomers(): BillingCustomer[];
  findCustomer(provider: BillingProvider, customerId: string): BillingCustomer | undefined;
  findCustomerForUser(provider: BillingProvider, userId: string): BillingCustomer | undefined;
  findUserForCustomer(provider: BillingProvider, customerId: string): string | undefined;
  findSubscription(userId: string, subscriptionId: string): BillingSubscription | undefined;
  findSubscriptionById(subscriptionId: string): BillingSubscription | undefined;
  listSubscriptions(filter?: BillingSubscriptionFilter): BillingSubscription[];
  countSubscriptions(filter?: BillingSubscriptionFilter): number;
  findCheckout(checkoutId: string): BillingCheckout | undefined;
  findCheckoutByUserKey(userId: string, idempotencyKey: string): BillingCheckout | undefined;
  listCheckouts(): BillingCheckout[];
  findCharge(chargeId: string): BillingCharge | undefined;
  findChargeForNonce(subscriptionId: string, chargeNonce: number): BillingCharge | undefined;
  listCharges(): BillingCharge[];
  listChargesForSubscription(subscriptionId: string): BillingCharge[];
  listEntitlementHistory(subscriptionId?: string): BillingEntitlementEvent[];
  listProcessedEvents(): BillingEventRecord[];
  hasProcessedEvent(provider: BillingEventRecord['provider'] | undefined, eventId: string): boolean;
}

function addExactFilter(conditions: string[], parameters: Array<string | number>, field: string, value: string | undefined): void {
  if (!value) return;
  conditions.push(`${field} = ?`);
  parameters.push(value);
}

function addContainsFilter(conditions: string[], parameters: Array<string | number>, fields: string[], value: string | undefined): void {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return;
  const pattern = `%${normalized.replace(/[\\%_]/g, '\\$&')}%`;
  conditions.push(`(${fields.map((field) => `lower(COALESCE(${field}, '')) LIKE ? ESCAPE '\\'`).join(' OR ')})`);
  parameters.push(...fields.map(() => pattern));
}

function addDateFilter(conditions: string[], parameters: Array<string | number>, comparison: '>=' | '<=', value: string | undefined): void {
  if (!value) return;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    conditions.push('0 = 1');
    return;
  }
  conditions.push(`subscriptions.updated_at ${comparison} ?`);
  parameters.push(timestamp);
}

function subscriptionConditions(filter: BillingSubscriptionFilter): { sql: string; parameters: Array<string | number> } {
  const conditions: string[] = [];
  const parameters: Array<string | number> = [];
  if (filter.userId) {
    conditions.push('subscriptions.user_id = ?');
    parameters.push(filter.userId);
  }
  addExactFilter(conditions, parameters, 'subscriptions.provider', filter.provider);
  addExactFilter(conditions, parameters, 'subscriptions.status', filter.status);
  addExactFilter(conditions, parameters, 'subscriptions.plan_id', filter.planId);
  addDateFilter(conditions, parameters, '>=', filter.from);
  addDateFilter(conditions, parameters, '<=', filter.to);
  addContainsFilter(conditions, parameters, ['subscriptions.wallet_address'], filter.wallet);
  addContainsFilter(conditions, parameters, ['subscriptions.checkout_id', 'subscriptions.provider_payment_id', 'subscriptions.subscription_id'], filter.invoice);
  addContainsFilter(conditions, parameters, [
    'subscriptions.user_id',
    'subscriptions.subscription_id',
    'subscriptions.plan_id',
    'subscriptions.provider',
    "json_extract(profiles.payload, '$.value.displayName')",
    "json_extract(profiles.payload, '$.value.username')",
    "json_extract(profiles.payload, '$.value.email')",
  ], filter.query);
  return { sql: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '', parameters };
}

export function createBillingRepository(database: Database): BillingRepository {
  return {
    listCustomers() {
      const rows = database.query('SELECT payload FROM billing_customers ORDER BY ordinal ASC, id ASC;').all() as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingCustomer);
    },
    findCustomer(provider, customerId) {
      const row = database.query('SELECT payload FROM billing_customers WHERE provider = ? AND customer_id = ? LIMIT 1;').get(provider, customerId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCustomer : undefined;
    },
    findCustomerForUser(provider, userId) {
      const row = database.query('SELECT payload FROM billing_customers WHERE provider = ? AND user_id = ? ORDER BY ordinal ASC, id LIMIT 1;').get(provider, userId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCustomer : undefined;
    },
    findUserForCustomer(provider, customerId) {
      const row = database.query('SELECT user_id FROM billing_customers WHERE provider = ? AND customer_id = ? LIMIT 1;').get(provider, customerId) as { user_id: string | null } | null;
      return row?.user_id ?? undefined;
    },
    findSubscription(userId, subscriptionId) {
      const row = database.query('SELECT payload FROM billing_subscriptions WHERE user_id = ? AND subscription_id = ? ORDER BY ordinal ASC LIMIT 1;').get(userId, subscriptionId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingSubscription : undefined;
    },
    findSubscriptionById(subscriptionId) {
      const row = database.query('SELECT payload FROM billing_subscriptions WHERE subscription_id = ? ORDER BY ordinal ASC LIMIT 1;').get(subscriptionId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingSubscription : undefined;
    },
    listSubscriptions(filter = {}) {
      const conditions = subscriptionConditions(filter);
      const rows = database.query(`
        SELECT subscriptions.payload
        FROM billing_subscriptions AS subscriptions
        LEFT JOIN auth_profiles AS profiles ON profiles.id = subscriptions.user_id
        ${conditions.sql}
        ORDER BY subscriptions.ordinal ASC, subscriptions.id ASC;
      `).all(...conditions.parameters) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingSubscription);
    },
    countSubscriptions(filter = {}) {
      const conditions = subscriptionConditions(filter);
      const row = database.query(`
        SELECT count(*) AS total
        FROM billing_subscriptions AS subscriptions
        LEFT JOIN auth_profiles AS profiles ON profiles.id = subscriptions.user_id
        ${conditions.sql};
      `).get(...conditions.parameters) as { total: number };
      return row.total;
    },
    findCheckout(checkoutId) {
      const row = database.query('SELECT payload FROM billing_checkouts WHERE checkout_id = ? ORDER BY ordinal ASC LIMIT 1;').get(checkoutId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCheckout : undefined;
    },
    findCheckoutByUserKey(userId, idempotencyKey) {
      const row = database.query('SELECT payload FROM billing_checkouts WHERE user_id = ? AND idempotency_key = ? ORDER BY ordinal ASC LIMIT 1;').get(userId, idempotencyKey) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCheckout : undefined;
    },
    listCheckouts() {
      const rows = database.query('SELECT payload FROM billing_checkouts ORDER BY ordinal ASC, id ASC;').all() as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingCheckout);
    },
    findCharge(chargeId) {
      const row = database.query('SELECT payload FROM billing_charges WHERE charge_id = ? ORDER BY ordinal ASC LIMIT 1;').get(chargeId) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCharge : undefined;
    },
    findChargeForNonce(subscriptionId, chargeNonce) {
      const row = database.query('SELECT payload FROM billing_charges WHERE subscription_id = ? AND charge_nonce = ? ORDER BY ordinal ASC LIMIT 1;').get(subscriptionId, chargeNonce) as { payload: string } | null;
      return row ? JSON.parse(row.payload) as BillingCharge : undefined;
    },
    listCharges() {
      const rows = database.query('SELECT payload FROM billing_charges ORDER BY ordinal ASC, id ASC;').all() as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingCharge);
    },
    listChargesForSubscription(subscriptionId) {
      const rows = database.query('SELECT payload FROM billing_charges WHERE subscription_id = ? ORDER BY ordinal ASC, id ASC;').all(subscriptionId) as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingCharge);
    },
    listEntitlementHistory(subscriptionId) {
      const query = subscriptionId
        ? database.query('SELECT payload FROM billing_entitlement_history WHERE subscription_id = ? ORDER BY updated_at DESC, id DESC;')
        : database.query('SELECT payload FROM billing_entitlement_history ORDER BY updated_at DESC, id DESC;');
      const rows = subscriptionId ? query.all(subscriptionId) : query.all();
      return (rows as Array<{ payload: string }>).map((row) => JSON.parse(row.payload) as BillingEntitlementEvent);
    },
    listProcessedEvents() {
      const rows = database.query('SELECT payload FROM billing_events ORDER BY provider, event_id;').all() as Array<{ payload: string }>;
      return rows.map((row) => JSON.parse(row.payload) as BillingEventRecord);
    },
    hasProcessedEvent(provider, eventId) {
      const result = provider
        ? database.query('SELECT 1 AS found FROM billing_events WHERE provider = ? AND event_id = ? LIMIT 1;').get(provider, eventId)
        : database.query('SELECT 1 AS found FROM billing_events WHERE event_id = ? LIMIT 1;').get(eventId);
      return !!result;
    },
  };
}
