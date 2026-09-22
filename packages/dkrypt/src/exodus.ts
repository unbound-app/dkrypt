import { createHmac, timingSafeEqual } from 'node:crypto';
import { CheckoutSigner, type SignedRequest, type SubscriptionObject } from '@exodus/checkout-signer';
import {
  config,
  cryptoBillingEnabled,
  exodusConfigured,
  exodusEnvironment,
  exodusMissingConfiguration,
} from '#config.js';
import type { BillingCharge, BillingCheckout, BillingTaxAddress, BillingTaxStatus, BillingSubscription, PlanId } from '#billing.js';
import { getCryptoTaxReadiness } from '#cryptoTax.js';

const SUBSCRIPTION_PERIOD_SECONDS = 30 * 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 15_000;
const BASE_CHAIN = 'eip155:8453';
const SUPPORTED_ASSETS = ['USDC', 'USDT'] as const;

export interface ExodusSettings {
  is_test?: boolean;
  settlement_type?: string;
  currency?: string;
  chain_configs?: unknown;
  webhook_url?: string;
}

export interface ExodusSubscription {
  id: string;
  status?: string;
  external_customer_id?: string;
  subscriber?: string | { address?: string; wallet_address?: string };
  wallet_address?: string;
  asset?: string;
  token_symbol?: string;
  chain?: string;
  price?: string | number;
  charge_amount?: string | number;
  price_currency?: string | null;
  period_duration?: number;
  next_charge_at?: string;
  next_charge_time?: string;
  last_charged_at?: string;
  last_charge_id?: string;
  subscription_charge_id?: string;
  last_charge_status?: string;
  last_charge_tx_hash?: string;
  charged_at?: string;
  failure_reason?: string;
  charge_nonce: number;
  subscription_manager_address: string;
  paused?: boolean;
  flagged?: boolean;
  metadata?: Record<string, string>;
}

export interface ExodusSubscriptionCheckout {
  id: string;
  status?: string;
  checkout_url?: string;
  url?: string;
  external_customer_id?: string;
  price?: string | number;
  price_currency?: string;
  metadata?: Record<string, string>;
  subscription?: ExodusSubscription;
}

export interface ExodusChargeQuote {
  amount?: string | number;
  charge_amount?: string | number;
  price_lock_code?: string;
  expires_at?: string;
}

export interface ExodusEvent {
  id: string;
  type: string;
  created_at?: string | number;
  data?: { object?: unknown; subscription?: unknown; charge?: unknown; checkout?: unknown };
}

export interface ExodusProviderStatus {
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  environment: 'test' | 'live';
  settlementType?: string;
  settlementCurrency: string;
  supportedChains: string[];
  supportedAssets: string[];
  missingConfiguration: string[];
  issues: string[];
  taxReady: boolean;
  taxWarning?: string;
  checkedAt?: string;
}

export class ExodusApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ExodusApiError';
  }
}

type FetchLike = typeof fetch;

export class ExodusClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(options: { baseUrl?: string; apiKey?: string; fetchFn?: FetchLike } = {}) {
    this.baseUrl = (options.baseUrl ?? config.exodusApiBaseUrl).replace(/\/$/, '');
    this.apiKey = options.apiKey ?? config.exodusApiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async getSettings(): Promise<ExodusSettings> {
    return this.request<ExodusSettings>('/settings');
  }

  async createSubscriptionCheckout(input: {
    userId: string;
    planId: Exclude<PlanId, 'viewer'>;
    planName?: string;
    planDescription?: string;
    amount: number;
    currency: string;
    taxAddress?: BillingTaxAddress;
    taxCalculationId?: string;
    idempotencyKey: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<ExodusSubscriptionCheckout> {
    const amountMinor = Math.round(input.amount * 100);
    return this.request<ExodusSubscriptionCheckout>('/subscription-checkouts', {
      method: 'POST',
      headers: { 'Idempotency-Key': input.idempotencyKey },
      body: {
        supported_chains: [BASE_CHAIN],
        price: String(amountMinor),
        price_currency: input.currency,
        period_duration: SUBSCRIPTION_PERIOD_SECONDS,
        cap: String(amountMinor),
        budget: String(amountMinor),
        initial_charge: true,
        external_customer_id: `dkrypt:${input.userId}`,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        return_url: input.successUrl,
        metadata: {
          dkrypt_user_id: input.userId,
          plan_id: input.planId,
          plan_name: input.planName ?? input.planId,
          plan_description: input.planDescription ?? '',
          tax_calculation_id: input.taxCalculationId ?? '',
          tax_country: input.taxAddress?.country ?? '',
        },
      },
    });
  }

  async getSubscription(subscriptionId: string): Promise<ExodusSubscription> {
    return this.request<ExodusSubscription>(`/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  async getChargeQuote(subscriptionId: string): Promise<ExodusChargeQuote> {
    return this.request<ExodusChargeQuote>(`/subscriptions/${encodeURIComponent(subscriptionId)}/charge-quote`, { method: 'POST', body: {} });
  }

  async chargeSubscription(subscription: ExodusSubscription, quote: ExodusChargeQuote): Promise<unknown> {
    const signer = new CheckoutSigner(config.exodusSigningKey);
    const amount = quote.amount ?? quote.charge_amount ?? subscription.price ?? subscription.charge_amount;
    if (amount === undefined) throw new Error('Exodus charge quote did not include an amount');
    const signed = signer.signCharge(subscription as SubscriptionObject, { amount: BigInt(amount) });
    return this.submitSignedRequest(
      `/subscriptions/${encodeURIComponent(subscription.id)}/charge`,
      signed,
      { price_lock_code: quote.price_lock_code },
    );
  }

  async cancelSubscription(subscription: ExodusSubscription): Promise<unknown> {
    const signer = new CheckoutSigner(config.exodusSigningKey);
    const signed = signer.signCancelSubscription(subscription as SubscriptionObject);
    return this.submitSignedRequest(`/subscriptions/${encodeURIComponent(subscription.id)}/cancel`, signed);
  }

  private async submitSignedRequest(path: string, signed: SignedRequest, extra: Record<string, unknown> = {}): Promise<unknown> {
    return this.request(path, {
      method: 'POST',
      headers: { 'X-Signature': signed.signature },
      body: { ...(signed.body ?? {}), ...extra },
    });
  }

  private async request<T>(path: string, input: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<T> {
    if (!this.apiKey) throw new ExodusApiError('Exodus API key is not configured', 0, false);
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: input.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...input.headers,
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = undefined;
    }
    if (!response.ok) {
      const detail = typeof payload === 'object' && payload !== null ? (payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error : undefined;
      const message = typeof detail === 'string' ? detail : `Exodus API returned HTTP ${response.status}`;
      throw new ExodusApiError(message, response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    return payload as T;
  }
}

let readinessCache: { expiresAt: number; status: ExodusProviderStatus } | undefined;

export async function getExodusProviderStatus(client = new ExodusClient()): Promise<ExodusProviderStatus> {
  const now = Date.now();
  if (readinessCache && readinessCache.expiresAt > now) return readinessCache.status;

  const baseStatus: ExodusProviderStatus = {
    enabled: cryptoBillingEnabled,
    configured: exodusConfigured,
    ready: false,
    environment: exodusEnvironment,
    settlementCurrency: config.exodusSettlementCurrency,
    supportedChains: [...config.exodusSupportedChains],
    supportedAssets: [...config.exodusSupportedAssets],
    missingConfiguration: [...exodusMissingConfiguration],
    issues: [],
    taxReady: false,
  };
  if (!exodusConfigured) {
    baseStatus.issues.push('provider configuration is incomplete');
    return baseStatus;
  }
  if (config.exodusSupportedChains.length !== 1 || config.exodusSupportedChains[0] !== BASE_CHAIN) baseStatus.issues.push('only Base is supported in EXODUS_CHECKOUT_SUPPORTED_CHAINS');
  if (config.exodusSupportedAssets.length !== SUPPORTED_ASSETS.length || SUPPORTED_ASSETS.some((asset) => !config.exodusSupportedAssets.includes(asset))) baseStatus.issues.push('EXODUS_CHECKOUT_SUPPORTED_ASSETS must contain exactly USDC and USDT');

  try {
    const settings = await client.getSettings();
    baseStatus.settlementType = typeof settings.settlement_type === 'string' ? settings.settlement_type : undefined;
    if (settings.is_test !== undefined && settings.is_test !== (exodusEnvironment === 'test')) baseStatus.issues.push('provider environment does not match the configured API key');
    if (settings.settlement_type !== 'FIAT') baseStatus.issues.push('Exodus settlement must be FIAT');
    if (settings.currency !== config.exodusSettlementCurrency) baseStatus.issues.push(`Exodus settlement currency must be ${config.exodusSettlementCurrency}`);
    if (!hasActiveBaseSigner(settings.chain_configs)) baseStatus.issues.push('Exodus does not report an active EVM signer for Base');
    const taxStatus = await getCryptoTaxReadiness();
    baseStatus.taxReady = taxStatus.ready;
    baseStatus.taxWarning = taxStatus.warning;
    baseStatus.issues.push(...taxStatus.issues);
    baseStatus.ready = baseStatus.issues.length === 0;
    baseStatus.checkedAt = new Date(now).toISOString();
    readinessCache = { expiresAt: now + 60_000, status: baseStatus };
    return baseStatus;
  } catch (error) {
    baseStatus.issues.push(error instanceof ExodusApiError ? error.message : 'could not read Exodus settings');
    baseStatus.checkedAt = new Date(now).toISOString();
    readinessCache = { expiresAt: now + 15_000, status: baseStatus };
    return baseStatus;
  }
}

export function clearExodusProviderStatusCache(): void {
  readinessCache = undefined;
}

export function verifyExodusWebhook(rawBody: Buffer | string, signature: string, secret = config.exodusWebhookSecret): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  return safeCompare(expected, signature);
}

export function verifyExodusWebhookWithRotation(rawBody: Buffer | string, signature: string, previousSignature = ''): boolean {
  return (
    verifyExodusWebhook(rawBody, signature, config.exodusWebhookSecret) ||
    verifyExodusWebhook(rawBody, signature, config.exodusWebhookSecretPrevious) ||
    verifyExodusWebhook(rawBody, previousSignature, config.exodusWebhookSecret)
  );
}

export function checkoutFromResponse(response: ExodusSubscriptionCheckout, input: {
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  amount: number;
  currency: string;
  idempotencyKey: string;
  taxAddress?: BillingTaxAddress;
  taxCalculationId?: string;
  taxStatus?: BillingTaxStatus;
}): BillingCheckout {
  const checkoutUrl = response.checkout_url ?? response.url;
  if (!response.id || !checkoutUrl) throw new Error('Exodus did not return a checkout URL');
  return {
    provider: 'exodus',
    checkoutId: response.id,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    planId: input.planId,
    amount: input.amount,
    currency: input.currency,
    status: checkoutStatus(response.status),
    checkoutUrl,
    taxAddress: input.taxAddress,
    taxCalculationId: input.taxCalculationId,
    taxStatus: input.taxStatus,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function subscriptionFromResponse(subscription: ExodusSubscription, input: {
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  checkoutId?: string;
  taxAddress?: BillingTaxAddress;
  taxStatus?: BillingTaxStatus;
  taxTransactionId?: string;
  occurredAt?: string;
}): BillingSubscription {
  const occurredAt = input.occurredAt ?? new Date().toISOString();
  return {
    provider: 'exodus',
    subscriptionId: subscription.id,
    customerId: subscription.external_customer_id ?? `dkrypt:${input.userId}`,
    userId: input.userId,
    status: subscription.status ?? 'active',
    planId: input.planId,
    priceId: `exodus:${input.planId}`,
    productId: 'dkrypt',
    checkoutId: input.checkoutId,
    externalCustomerId: subscription.external_customer_id,
    currency: subscription.price_currency ?? config.exodusSettlementCurrency,
    amount: minorToMajor(subscription.price ?? subscription.charge_amount),
    interval: '30d',
    walletAddress: typeof subscription.subscriber === 'string' ? subscription.subscriber : subscription.subscriber?.address ?? subscription.subscriber?.wallet_address ?? subscription.wallet_address,
    chain: subscription.chain,
    asset: subscription.token_symbol ?? subscription.asset,
    nextBilledAt: subscription.next_charge_at ?? subscription.next_charge_time,
    lastChargeAt: subscription.last_charged_at,
    lastChargeId: subscription.last_charge_id,
    lastChargeStatus: billingChargeStatus(subscription.last_charge_status),
    lastChargeTxHash: subscription.last_charge_tx_hash,
    paused: subscription.paused,
    flagged: subscription.flagged,
    taxAddress: input.taxAddress,
    taxStatus: input.taxStatus,
    taxTransactionId: input.taxTransactionId,
    occurredAt,
    updatedAt: occurredAt,
  };
}

export function isSupportedExodusSubscription(subscription: ExodusSubscription): boolean {
  const asset = subscription.token_symbol ?? subscription.asset;
  return !!subscription.chain && !!asset && config.exodusSupportedChains.includes(subscription.chain) && config.exodusSupportedAssets.includes(asset.toUpperCase());
}

function safeCompare(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual.trim(), 'utf8');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function hasActiveBaseSigner(value: unknown): boolean {
  const entries = Array.isArray(value) ? value : typeof value === 'object' && value !== null ? Object.entries(value).map(([chain, entry]) => ({ chain, ...(typeof entry === 'object' && entry !== null ? entry : {}) })) : [];
  return entries.some((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const record = entry as Record<string, unknown>;
    const chain = record.chain ?? record.chain_id ?? record.id;
    const family = record.chain_family ?? record.family;
    const status = record.signer_status ?? record.status;
    return (chain === 'eip155:8453' || (family === 'evm' && config.exodusSupportedChains.includes('eip155:8453'))) && status === 'active';
  });
}

function minorToMajor(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  const numberValue = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(numberValue) ? numberValue / 100 : undefined;
}

function billingChargeStatus(value: string | undefined): BillingCharge['status'] | undefined {
  if (value === 'pending' || value === 'succeeded' || value === 'failed') return value;
  return undefined;
}

function checkoutStatus(value: string | undefined): BillingCheckout['status'] {
  if (value === 'completed' || value === 'expired' || value === 'cancelled') return value;
  return 'pending';
}
