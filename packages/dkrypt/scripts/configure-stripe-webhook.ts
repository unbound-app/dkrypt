import Stripe from 'stripe';
import { createStripeCliClient } from './stripe-cli.js';

const destination = process.env.STRIPE_WEBHOOK_URL;
if (!destination) throw new Error('STRIPE_WEBHOOK_URL is required');
if (!destination.startsWith('https://')) throw new Error('STRIPE_WEBHOOK_URL must use HTTPS');

const { client: stripe, environment } = createStripeCliClient();
const enabledEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = [
  'checkout.session.completed',
  'checkout.session.async_payment_failed',
  'checkout.session.async_payment_succeeded',
  'customer.created',
  'customer.updated',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
];

const endpoints = await stripe.webhookEndpoints.list({ limit: 100 });
const existing = endpoints.data.find((endpoint) => endpoint.url === destination);
const endpoint = existing
  ? await stripe.webhookEndpoints.update(existing.id, { description: 'dkrypt Stripe billing', enabled_events: enabledEvents, disabled: false })
  : await stripe.webhookEndpoints.create({ url: destination, description: 'dkrypt Stripe billing', enabled_events: enabledEvents });

console.log(
  JSON.stringify(
    {
      environment,
      endpointId: endpoint.id,
      destination: endpoint.url,
      endpointSecret: endpoint.secret,
      secretAction: endpoint.secret ? 'store STRIPE_WEBHOOK_SECRET in the runtime environment' : 'existing endpoint secret is unchanged',
    },
    null,
    2,
  ),
);
