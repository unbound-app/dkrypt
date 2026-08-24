import Stripe from 'stripe';

export function createStripeCliClient(): { client: Stripe; environment: 'live' | 'test' } {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) throw new Error('STRIPE_SECRET_KEY is required');
  return {
    client: new Stripe(apiKey, { apiVersion: '2026-02-25.clover' }),
    environment: apiKey.startsWith('sk_live_') ? 'live' : 'test',
  };
}
