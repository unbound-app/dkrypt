import { createHmac, randomBytes } from 'node:crypto';
import Stripe from 'stripe';
import { createStripeCliClient } from './stripe-cli.js';

const webhookUrl = process.env.STRIPE_WEBHOOK_URL;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const taxCode = process.env.STRIPE_TAX_CODE;
if (!webhookUrl) throw new Error('STRIPE_WEBHOOK_URL is required');
if (!webhookUrl.startsWith('https://')) throw new Error('STRIPE_WEBHOOK_URL must use HTTPS');
if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is required');
if (!taxCode) throw new Error('STRIPE_TAX_CODE is required and must be eligible for Managed Payments');

const expectedPrices = [
  { key: 'STRIPE_REGULAR_PRICE_ID', amount: 500 },
  { key: 'STRIPE_PRIORITY_PRICE_ID', amount: 1000 },
  { key: 'STRIPE_API_PRICE_ID', amount: 1500 },
  { key: 'STRIPE_PRIORITY_API_PRICE_ID', amount: 2000 },
] as const;

const requiredEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const { client: stripe, environment } = createStripeCliClient();

function createIntegrationIdentifier(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const suffix = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  return `dkrypt_${suffix}`;
}

const priceIds = expectedPrices.map(({ key }) => ({ key, id: process.env[key] }));
const missingPrice = priceIds.find(({ id }) => !id);
if (missingPrice) throw new Error(`${missingPrice.key} is required`);

const [account, prices, endpoints] = await Promise.all([
  stripe.accounts.retrieve(),
  Promise.all(priceIds.map(({ id }) => stripe.prices.retrieve(id as string))),
  stripe.webhookEndpoints.list({ limit: 100 }),
]);
const productIds = [...new Set(prices.map((price) => (typeof price.product === 'string' ? price.product : price.product.id)))];
const products = await Promise.all(productIds.map((id) => stripe.products.retrieve(id)));
const productChecks = products.map((product) => ({ id: product.id, taxCode: product.tax_code, valid: product.active && product.tax_code === taxCode }));

const priceChecks = prices.map((price, index) => {
  const expected = expectedPrices[index];
  return {
    key: expected.key,
    id: price.id,
    valid:
      price.active &&
      price.currency === 'eur' &&
      price.type === 'recurring' &&
      price.unit_amount === expected.amount &&
      price.recurring?.interval === 'month' &&
      price.recurring.interval_count === 1,
  };
});
const endpoint = endpoints.data.find((candidate) => candidate.url === webhookUrl && candidate.status === 'enabled');
const configuredEvents = new Set(endpoint?.enabled_events ?? []);
const missingEvents = requiredEvents.filter((event) => !configuredEvents.has(event));
const webhookProbe = endpoint
  ? await (async () => {
      const probePayload = JSON.stringify({
        id: `evt_dkrypt_verification_${Date.now()}`,
        object: 'event',
        api_version: null,
        created: Math.floor(Date.now() / 1000),
        data: { object: {} },
        livemode: environment === 'live',
        pending_webhooks: 1,
        request: null,
        type: 'dkrypt.verification',
      });
      const probeTimestamp = Math.floor(Date.now() / 1000);
      const probeSignature = `t=${probeTimestamp},v1=${createHmac('sha256', webhookSecret).update(`${probeTimestamp}.${probePayload}`).digest('hex')}`;
      const probeResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'stripe-signature': probeSignature },
        body: probePayload,
      });
      const probeBody = (await probeResponse.json().catch(() => ({}))) as { received?: boolean };
      return { status: probeResponse.status, received: probeBody.received === true };
    })()
  : { status: null, received: false };
const managedPaymentsProbe = await (async () => {
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: prices[0].id, quantity: 1 }],
    success_url: `${webhookUrl}/managed-payments-verification-success`,
    cancel_url: `${webhookUrl}/managed-payments-verification-cancel`,
    billing_address_collection: 'required',
    managed_payments: { enabled: true },
    integration_identifier: createIntegrationIdentifier(),
  });
  const managedPayments = session.managed_payments;
  await stripe.checkout.sessions.expire(session.id);
  return { id: session.id, enabled: managedPayments?.enabled === true };
})();
const checks = {
  account: account.id,
  chargesEnabled: account.charges_enabled,
  environment,
  prices: priceChecks,
  products: productChecks,
  webhook: endpoint
    ? { id: endpoint.id, url: endpoint.url, missingEvents }
    : { id: null, url: webhookUrl, missingEvents: requiredEvents },
  webhookProbe,
  managedPaymentsProbe,
};

if (priceChecks.some(({ valid }) => !valid) || productChecks.some(({ valid }) => !valid) || !endpoint || missingEvents.length > 0 || !webhookProbe.received || !managedPaymentsProbe.enabled) {
  throw new Error(JSON.stringify(checks, null, 2));
}

console.log(JSON.stringify(checks, null, 2));
