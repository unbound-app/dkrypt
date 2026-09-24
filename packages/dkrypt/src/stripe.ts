import Stripe from 'stripe';
import { config } from '#config.js';

let stripe: Stripe | undefined;

export function getStripe(): Stripe {
  if (!config.stripeSecretKey) throw new Error('Stripe secret key is not configured');
  stripe ??= new Stripe(config.stripeSecretKey, { apiVersion: '2026-08-26.dahlia' });
  return stripe;
}

export async function constructStripeWebhookEvent(rawBody: string | Buffer, signature: string): Promise<Stripe.Event> {
  let lastError: unknown;
  for (const secret of [config.stripeWebhookSecret, config.stripeWebhookSecretPrevious].filter(Boolean)) {
    try {
      return await getStripe().webhooks.constructEventAsync(rawBody, signature, secret);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Stripe webhook signature verification failed');
}
