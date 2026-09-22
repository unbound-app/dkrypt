import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  config,
  cryptoBillingEnabled,
  nowpaymentsConfigured,
  nowpaymentsEnvironment,
  nowpaymentsMissingConfiguration,
} from '#config.js';
import type { BillingCheckout, BillingSubscription, PlanId } from '#billing.js';

const REQUEST_TIMEOUT_MS = 15_000;

export interface NowPaymentsInvoice {
  id: string | number;
  invoice_url?: string;
  order_id?: string;
  order_description?: string;
  price_amount?: number | string;
  price_currency?: string;
  pay_currency?: string | null;
  ipn_callback_url?: string;
  success_url?: string;
  cancel_url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NowPaymentsPayment {
  payment_id?: string | number;
  payment_status?: string;
  invoice_id?: string | number;
  order_id?: string;
  order_description?: string;
  price_amount?: string | number;
  price_currency?: string;
  pay_amount?: string | number;
  actually_paid?: string | number;
  pay_currency?: string;
  pay_address?: string;
  outcome_amount?: string | number;
  outcome_currency?: string;
  payin_hash?: string;
  outcome_tx_hash?: string;
  transaction_hash?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NowPaymentsEvent {
  id: string;
  payment: NowPaymentsPayment;
}

export interface NowPaymentsProviderStatus {
  enabled: boolean;
  configured: boolean;
  ready: boolean;
  environment: 'test' | 'live';
  settlementType: 'non-custodial';
  settlementCurrency: string;
  supportedChains: string[];
  supportedAssets: string[];
  missingConfiguration: string[];
  issues: string[];
  checkedAt?: string;
}

export class NowPaymentsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'NowPaymentsApiError';
  }
}

type FetchLike = typeof fetch;

export class NowPaymentsClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;

  constructor(options: { baseUrl?: string; apiKey?: string; fetchFn?: FetchLike } = {}) {
    this.baseUrl = (options.baseUrl ?? config.nowpaymentsApiBaseUrl).replace(/\/$/, '');
    this.apiKey = options.apiKey ?? config.nowpaymentsApiKey;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createInvoice(input: {
    amount: number;
    currency: string;
    payCurrency: string;
    orderId: string;
    orderDescription: string;
    ipnCallbackUrl: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<NowPaymentsInvoice> {
    return this.request<NowPaymentsInvoice>('/invoice', {
      method: 'POST',
      body: {
        price_amount: input.amount,
        price_currency: input.currency.toLowerCase(),
        pay_currency: input.payCurrency.toLowerCase(),
        ipn_callback_url: input.ipnCallbackUrl,
        order_id: input.orderId,
        order_description: input.orderDescription,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
    });
  }

  async getPaymentStatus(paymentId: string): Promise<NowPaymentsPayment> {
    return this.request<NowPaymentsPayment>(`/payment/${encodeURIComponent(paymentId)}`);
  }

  async getCurrencies(): Promise<string[]> {
    const payload = await this.request<unknown>('/currencies');
    if (Array.isArray(payload)) return payload.filter((value): value is string => typeof value === 'string');
    if (typeof payload === 'object' && payload !== null) {
      const currencies = (payload as { currencies?: unknown }).currencies;
      if (Array.isArray(currencies)) return currencies.filter((value): value is string => typeof value === 'string');
    }
    throw new NowPaymentsApiError('NOWPayments returned an invalid currency list', 200, false);
  }

  private async request<T>(path: string, input: { method?: string; body?: unknown } = {}): Promise<T> {
    if (!this.apiKey) throw new NowPaymentsApiError('NOWPayments API key is not configured', 0, false);
    const response = await this.fetchFn(`${this.baseUrl}${path}`, {
      method: input.method ?? 'GET',
      headers: {
        Accept: 'application/json',
        'x-api-key': this.apiKey,
        ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
      const detail = typeof payload === 'object' && payload !== null
        ? (payload as { message?: unknown; error?: unknown }).message ?? (payload as { error?: unknown }).error
        : undefined;
      const message = typeof detail === 'string' ? detail : `NOWPayments API returned HTTP ${response.status}`;
      throw new NowPaymentsApiError(message, response.status, response.status === 408 || response.status === 429 || response.status >= 500);
    }
    return payload as T;
  }
}

let readinessCache: { expiresAt: number; status: NowPaymentsProviderStatus } | undefined;

export async function getNowPaymentsProviderStatus(client = new NowPaymentsClient()): Promise<NowPaymentsProviderStatus> {
  const now = Date.now();
  if (readinessCache && readinessCache.expiresAt > now) return readinessCache.status;

  const status: NowPaymentsProviderStatus = {
    enabled: cryptoBillingEnabled,
    configured: nowpaymentsConfigured,
    ready: false,
    environment: nowpaymentsEnvironment,
    settlementType: 'non-custodial',
    settlementCurrency: config.nowpaymentsPriceCurrency,
    supportedChains: [],
    supportedAssets: [...config.nowpaymentsSupportedAssets],
    missingConfiguration: [...nowpaymentsMissingConfiguration],
    issues: [],
  };
  if (!nowpaymentsConfigured) {
    status.issues.push('provider configuration is incomplete');
    return status;
  }
  if (!config.nowpaymentsSupportedAssets.includes(config.nowpaymentsDefaultAsset)) status.issues.push('NOWPAYMENTS_DEFAULT_ASSET must be one of NOWPAYMENTS_SUPPORTED_ASSETS');

  try {
    const currencies = (await client.getCurrencies()).map((currency) => currency.toUpperCase());
    for (const asset of config.nowpaymentsSupportedAssets) {
      if (!currencies.some((currency) => currency === asset || currency.startsWith(`${asset}_`) || currency.startsWith(`${asset}-`))) {
        status.issues.push(`NOWPayments does not currently list ${asset} as available`);
      }
    }
    status.ready = status.issues.length === 0;
    status.checkedAt = new Date(now).toISOString();
    readinessCache = { expiresAt: now + 60_000, status };
    return status;
  } catch (error) {
    status.issues.push(error instanceof NowPaymentsApiError ? error.message : 'could not read NOWPayments currencies');
    status.checkedAt = new Date(now).toISOString();
    readinessCache = { expiresAt: now + 15_000, status };
    return status;
  }
}

export function clearNowPaymentsProviderStatusCache(): void {
  readinessCache = undefined;
}

export function verifyNowPaymentsWebhook(payload: unknown, signature: string, secret = config.nowpaymentsIpnSecret): boolean {
  if (!secret || !signature) return false;
  const canonical = JSON.stringify(sortObjectDeep(payload));
  const expected = createHmac('sha512', secret).update(canonical).digest('hex');
  return safeCompare(expected, signature);
}

export function verifyNowPaymentsWebhookWithRotation(payload: unknown, signature: string, previousSignature = ''): boolean {
  return (
    verifyNowPaymentsWebhook(payload, signature, config.nowpaymentsIpnSecret) ||
    verifyNowPaymentsWebhook(payload, signature, config.nowpaymentsIpnSecretPrevious) ||
    verifyNowPaymentsWebhook(payload, previousSignature, config.nowpaymentsIpnSecret)
  );
}

export function checkoutFromResponse(response: NowPaymentsInvoice, input: {
  checkoutId: string;
  orderId: string;
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  amount: number;
  currency: string;
  idempotencyKey: string;
  asset: string;
}): BillingCheckout {
  if (response.id === undefined || !response.invoice_url) throw new Error('NOWPayments did not return an invoice URL');
  const now = new Date().toISOString();
  return {
    provider: 'nowpayments',
    checkoutId: input.checkoutId,
    providerCheckoutId: String(response.id),
    orderId: input.orderId,
    userId: input.userId,
    idempotencyKey: input.idempotencyKey,
    planId: input.planId,
    amount: input.amount,
    currency: input.currency,
    status: 'pending',
    checkoutUrl: response.invoice_url,
    asset: input.asset,
    createdAt: now,
    updatedAt: now,
  };
}

export function subscriptionFromPayment(payment: NowPaymentsPayment, input: {
  userId: string;
  planId: Exclude<PlanId, 'viewer'>;
  checkoutId: string;
  occurredAt: string;
}): BillingSubscription {
  const paymentId = payment.payment_id === undefined ? input.checkoutId : String(payment.payment_id);
  const nextBilledAt = new Date(Date.parse(input.occurredAt) + 30 * 24 * 60 * 60 * 1000).toISOString();
  return {
    provider: 'nowpayments',
    subscriptionId: `nowpayments:${paymentId}`,
    providerPaymentId: paymentId,
    customerId: `nowpayments:${input.userId}`,
    userId: input.userId,
    status: 'active',
    planId: input.planId,
    priceId: `nowpayments:${input.planId}`,
    productId: 'dkrypt',
    checkoutId: input.checkoutId,
    externalCustomerId: `dkrypt:${input.userId}`,
    currency: payment.price_currency?.toUpperCase() ?? config.nowpaymentsPriceCurrency,
    amount: numberValue(payment.price_amount),
    interval: '30d',
    walletAddress: payment.pay_address,
    asset: payment.pay_currency?.toUpperCase(),
    nextBilledAt,
    lastChargeAt: input.occurredAt,
    lastChargeId: paymentId,
    lastChargeStatus: 'succeeded',
    lastChargeTxHash: payment.outcome_tx_hash ?? payment.payin_hash ?? payment.transaction_hash,
    occurredAt: input.occurredAt,
    updatedAt: input.occurredAt,
  };
}

export function isSupportedNowPaymentsPayment(payment: NowPaymentsPayment): boolean {
  const asset = payment.pay_currency?.toUpperCase();
  return !!asset && config.nowpaymentsSupportedAssets.some((supported) => asset === supported || asset.startsWith(`${supported}_`) || asset.startsWith(`${supported}-`));
}

function sortObjectDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectDeep);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, sortObjectDeep(entry)]));
}

function safeCompare(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual.trim(), 'utf8');
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined;
}
