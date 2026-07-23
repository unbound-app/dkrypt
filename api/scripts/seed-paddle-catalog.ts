import { Environment, Paddle } from '@paddle/paddle-node-sdk';

const environment = process.env.PADDLE_ENV === 'production' ? Environment.production : Environment.sandbox;
const environmentName = environment === Environment.production ? 'production' : 'sandbox';
const apiKey =
  process.env.PADDLE_API_KEY ??
  (environment === Environment.production ? process.env.PADDLE_LIVE_API_KEY : process.env.PADDLE_SANDBOX_API_KEY);

if (!apiKey) throw new Error(`Paddle API key is required for ${environmentName}`);

const paddle = new Paddle(apiKey, { environment });

const tiers = [
  { key: 'regular', name: 'dkrypt Regular', amount: '500' },
  { key: 'priority', name: 'dkrypt Priority', amount: '1000' },
  { key: 'api', name: 'dkrypt API', amount: '1000' },
  { key: 'priority_api', name: 'dkrypt Priority API', amount: '2000' },
] as const;

async function findProduct(key: string) {
  const products = paddle.products.list({ status: ['active'], perPage: 200 });
  for await (const product of products) {
    if (product.customData?.dkrypt_tier === key) return product;
  }
  return undefined;
}

async function findPrice(productId: string, key: string, amount: string) {
  const prices = paddle.prices.list({ productId: [productId], status: ['active'], recurring: true, perPage: 200 });
  for await (const price of prices) {
    if (
      price.billingCycle?.interval === 'month' &&
      price.billingCycle.frequency === 1 &&
      price.unitPrice.currencyCode === 'EUR' &&
      price.unitPrice.amount === amount &&
      price.customData?.dkrypt_tier === key
    ) {
      return price;
    }
  }
  return undefined;
}

async function seed() {
  const catalog: Record<string, { productId: string; priceId: string }> = {};

  for (const tier of tiers) {
    const product =
      (await findProduct(tier.key)) ??
      (await paddle.products.create({
        name: tier.name,
        description: `${tier.name} monthly subscription`,
        taxCategory: 'saas',
        customData: { dkrypt_tier: tier.key },
      }));

    const price =
      (await findPrice(product.id, tier.key, tier.amount)) ??
      (await paddle.prices.create({
        productId: product.id,
        name: `${tier.name} monthly EUR`,
        description: `${tier.name} monthly EUR`,
        unitPrice: { amount: tier.amount, currencyCode: 'EUR' },
        billingCycle: { interval: 'month', frequency: 1 },
        customData: { dkrypt_tier: tier.key },
      }));

    catalog[tier.key] = { productId: product.id, priceId: price.id };
  }

  let clientToken = '';
  const clientTokens = paddle.clientTokens.list({ status: ['active'], perPage: 200 });
  for await (const token of clientTokens) {
    if (token.name === `dkrypt web ${environmentName}`) {
      clientToken = token.token;
      break;
    }
  }

  if (!clientToken) {
    clientToken = (await paddle.clientTokens.create({ name: `dkrypt web ${environmentName}` })).token;
  }

  console.log(JSON.stringify({ environment: environmentName, currency: 'EUR', catalog, clientToken }, null, 2));
}

await seed();
