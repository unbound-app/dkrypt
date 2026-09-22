import { config, nowpaymentsEnvironment } from '#config.js';
import type { BillingTaxAddress } from '#billing.js';
import { getStripe } from '#stripe.js';

export interface CryptoTaxResult {
  calculationId?: string;
  amountTotal?: number;
  taxAmount?: number;
}

export interface CryptoTaxReadiness {
  ready: boolean;
  issues: string[];
  warning?: string;
}

export async function getCryptoTaxReadiness(): Promise<CryptoTaxReadiness> {
  if (config.cryptoTaxMode === 'manual') {
    if (nowpaymentsEnvironment === 'live' && !config.cryptoManualTaxAllowed) return { ready: false, issues: ['manual tax mode is not permitted for live crypto billing'] };
    return {
      ready: true,
      issues: [],
      warning: 'Crypto checkout is using manual tax mode; the operator is responsible for tax calculation and remittance.',
    };
  }
  const issues: string[] = [];
  if (!config.stripeSecretKey) issues.push('Stripe Tax requires STRIPE_SECRET_KEY');
  if (!config.stripeTaxCode) issues.push('Stripe Tax requires STRIPE_TAX_CODE');
  if (issues.length > 0) return { ready: false, issues };
  try {
    const settings = await getStripe().tax.settings.retrieve();
    if (settings.status !== 'active') issues.push('Stripe Tax settings are not active');
    if (settings.defaults.provider !== 'stripe') issues.push('Stripe Tax is configured with a different tax provider');
    if (settings.livemode !== (nowpaymentsEnvironment === 'live')) issues.push('Stripe Tax mode does not match the NOWPayments environment');
    if (nowpaymentsEnvironment === 'live') {
      const registrations = await getStripe().tax.registrations.list({ status: 'active', limit: 100 });
      if (registrations.data.length === 0) issues.push('Stripe Tax requires at least one active live registration');
    }
  } catch {
    issues.push('Stripe Tax settings could not be verified');
  }
  return { ready: issues.length === 0, issues };
}

export function normalizeTaxAddress(value: unknown): BillingTaxAddress | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const input = value as Record<string, unknown>;
  const country = typeof input.country === 'string' ? input.country.trim().toUpperCase() : '';
  const postalCode = typeof input.postalCode === 'string' ? input.postalCode.trim() : '';
  if (!/^[A-Z]{2}$/.test(country) || postalCode.length < 2 || postalCode.length > 32) return undefined;
  return {
    country,
    postalCode,
    state: normalizeAddressPart(input.state, 128),
    city: normalizeAddressPart(input.city, 128),
    line1: normalizeAddressPart(input.line1, 200),
    line2: normalizeAddressPart(input.line2, 200),
  };
}

export async function calculateCryptoTax(input: {
  amount: number;
  planId: string;
  address: BillingTaxAddress;
  idempotencyKey?: string;
}): Promise<CryptoTaxResult> {
  if (config.cryptoTaxMode === 'manual') return {};
  if (!config.stripeTaxCode) throw new Error('Stripe Tax is not configured for crypto billing');
  const calculation = await getStripe().tax.calculations.create({
    currency: 'eur',
    line_items: [
      {
        amount: Math.round(input.amount * 100),
        reference: `dkrypt:${input.planId}`,
        tax_code: config.stripeTaxCode,
        tax_behavior: 'inclusive',
        quantity: 1,
      },
    ],
    customer_details: {
      address: {
        country: input.address.country,
        postal_code: input.address.postalCode,
        state: input.address.state,
        city: input.address.city,
        line1: input.address.line1,
        line2: input.address.line2,
      },
      address_source: 'billing',
    },
  }, input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : undefined);
  return {
    calculationId: calculation.id ?? undefined,
    amountTotal: calculation.amount_total,
    taxAmount: calculation.tax_amount_exclusive + (calculation.tax_amount_inclusive ?? 0),
  };
}

export async function recordCryptoTaxTransaction(input: {
  calculationId: string;
  reference: string;
  metadata: Record<string, string>;
}): Promise<string> {
  const transaction = await getStripe().tax.transactions.createFromCalculation({
    calculation: input.calculationId,
    reference: input.reference,
    metadata: input.metadata,
  }, { idempotencyKey: input.reference });
  return transaction.id;
}

function normalizeAddressPart(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : undefined;
}
