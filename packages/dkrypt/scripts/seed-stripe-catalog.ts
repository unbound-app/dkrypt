import Stripe from 'stripe';

const apiKey = process.env.STRIPE_SECRET_KEY;
if (!apiKey) throw new Error('STRIPE_SECRET_KEY is required');

const stripe = new Stripe(apiKey);
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
    const product =
      (await findProduct(tier.key)) ??
      (await stripe.products.create({
        name: tier.name,
        description: `${tier.name} monthly subscription`,
        metadata: { dkrypt_tier: tier.key },
      }));

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

  console.log(JSON.stringify({ environment: apiKey.startsWith('sk_live_') ? 'live' : 'test', currency: 'EUR', catalog }, null, 2));
}

await seed();
