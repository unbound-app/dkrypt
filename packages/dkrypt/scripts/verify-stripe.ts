import Stripe from 'stripe';
import { createStripeCliClient } from './stripe-cli.js';

const webhookUrl = process.env.STRIPE_WEBHOOK_URL;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
if (!webhookUrl) throw new Error('STRIPE_WEBHOOK_URL is required');
if (!webhookUrl.startsWith('https://')) throw new Error('STRIPE_WEBHOOK_URL must use HTTPS');
if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is required');

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
const priceIds = expectedPrices.map(({ key }) => ({ key, id: process.env[key] }));
const missingPrice = priceIds.find(({ id }) => !id);
if (missingPrice) throw new Error(`${missingPrice.key} is required`);

const [account, prices, endpoints] = await Promise.all([
  stripe.accounts.retrieve(),
  Promise.all(priceIds.map(({ id }) => stripe.prices.retrieve(id as string))),
  stripe.webhookEndpoints.list({ limit: 100 }),
]);

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
const checks = {
  account: account.id,
  chargesEnabled: account.charges_enabled,
  environment,
  prices: priceChecks,
  webhook: endpoint
    ? { id: endpoint.id, url: endpoint.url, missingEvents }
    : { id: null, url: webhookUrl, missingEvents: requiredEvents },
};

if (priceChecks.some(({ valid }) => !valid) || !endpoint || missingEvents.length > 0) {
  throw new Error(JSON.stringify(checks, null, 2));
}

console.log(JSON.stringify(checks, null, 2));
