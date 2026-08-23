import Stripe from 'stripe';
import { config } from '#config.js';

let stripe: Stripe | undefined;

export function getStripe(): Stripe {
  if (!config.stripeSecretKey) throw new Error('Stripe secret key is not configured');
  stripe ??= new Stripe(config.stripeSecretKey);
  return stripe;
}
