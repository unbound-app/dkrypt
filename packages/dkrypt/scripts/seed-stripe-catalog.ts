import Stripe from 'stripe';
import { createStripeCliClient } from './stripe-cli.js';

const { client: stripe, environment } = createStripeCliClient();
const taxCode = process.env.STRIPE_TAX_CODE;
if (!taxCode) throw new Error('STRIPE_TAX_CODE is required and must be eligible for Managed Payments');
const tiers = [
  { key: 'regular', name: 'dkrypt Regular', amount: 500 },
  { key: 'priority', name: 'dkrypt Priority', amount: 1000 },
  { key: 'api', name: 'dkrypt API', amount: 1500 },
  { key: 'priority_api', name: 'dkrypt Priority API', amount: 2000 },
] as const;

async function findProduct(key: string): Promise<Stripe.Product | undefined> {
  for await (const product of stripe.products.list({ active: true, limit: 100 })) {
    if (product.metadata.dkrypt_tier === key) return product;
  }
  return undefined;
}

async function findPrice(productId: string, key: string, amount: number): Promise<Stripe.Price | undefined> {
  for await (const price of stripe.prices.list({ product: productId, active: true, type: 'recurring', limit: 100 })) {
    if (
      price.currency === 'eur' &&
      price.unit_amount === amount &&
      price.recurring?.interval === 'month' &&
      price.recurring.interval_count === 1 &&
      price.metadata.dkrypt_tier === key
    ) {
      return price;
    }
  }
  return undefined;
}

async function seed(): Promise<void> {
  const catalog: Record<string, { productId: string; priceId: string }> = {};

  for (const tier of tiers) {
    let product =
      (await findProduct(tier.key)) ??
      (await stripe.products.create({
        name: tier.name,
        description: `${tier.name} monthly subscription`,
        tax_code: taxCode,
        metadata: { dkrypt_tier: tier.key },
      }));

    if (product.tax_code !== taxCode) product = await stripe.products.update(product.id, { tax_code: taxCode });

    const price =
      (await findPrice(product.id, tier.key, tier.amount)) ??
      (await stripe.prices.create({
        product: product.id,
        nickname: `${tier.name} monthly EUR`,
        currency: 'eur',
        unit_amount: tier.amount,
        recurring: { interval: 'month', interval_count: 1 },
        metadata: { dkrypt_tier: tier.key },
      }));

    catalog[tier.key] = { productId: product.id, priceId: price.id };
  }

  console.log(JSON.stringify({ environment, currency: 'EUR', catalog }, null, 2));
}

await seed();
