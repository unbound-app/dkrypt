import Stripe from 'stripe';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { config } from '#config.js';
import { STRIPE_WEBHOOK_EVENTS } from '#stripeWebhookEvents.js';
import { clearStripeWebhookHealthCache, getStripeWebhookHealth, StripeWebhookEndpointNotFoundError, syncStripeWebhookEvents } from '#stripeWebhookHealth.js';

const previousStripeSecretKey = config.stripeSecretKey;
const previousPublicBaseUrl = config.publicBaseUrl;

beforeEach(() => {
  config.stripeSecretKey = 'sk_test_dkrypt_webhook_health';
  config.publicBaseUrl = 'https://dkrypt.example';
  clearStripeWebhookHealthCache();
});

afterEach(() => {
  config.stripeSecretKey = previousStripeSecretKey;
  config.publicBaseUrl = previousPublicBaseUrl;
  clearStripeWebhookHealthCache();
});

function createStripeClient(endpoints: Array<Record<string, unknown>>, onList?: () => void): Stripe {
  return {
    webhookEndpoints: {
      list: async () => {
        onList?.();
        return { data: endpoints };
      },
    },
  } as unknown as Stripe;
}

test('Stripe webhook health accepts an enabled endpoint with every required event and caches the result', async () => {
  let calls = 0;
  const client = createStripeClient([{
    id: 'we_dkrypt',
    url: 'https://dkrypt.example/v1/stripe/webhook',
    status: 'enabled',
    enabled_events: [...STRIPE_WEBHOOK_EVENTS],
  }], () => { calls += 1; });

  const first = await getStripeWebhookHealth(client, 10_000);
  const second = await getStripeWebhookHealth(client, 10_001);

  expect(first).toMatchObject({ state: 'ready', endpointUrl: 'https://dkrypt.example/v1/stripe/webhook', missingEvents: [] });
  expect(first.checkedAt).toBe(new Date(10_000).toISOString());
  expect(second).toEqual(first);
  expect(calls).toBe(1);
});

test('Stripe webhook health can bypass its cache and replace it with a fresh result', async () => {
  let calls = 0;
  const client = createStripeClient([{
    id: 'we_dkrypt',
    url: 'https://dkrypt.example/v1/stripe/webhook',
    status: 'enabled',
    enabled_events: [...STRIPE_WEBHOOK_EVENTS],
  }], () => { calls += 1; });

  const first = await getStripeWebhookHealth(client, 15_000);
  const refreshed = await getStripeWebhookHealth(client, 15_001, true);
  const cachedRefresh = await getStripeWebhookHealth(client, 15_002);

  expect(first.checkedAt).toBe(new Date(15_000).toISOString());
  expect(refreshed.checkedAt).toBe(new Date(15_001).toISOString());
  expect(cachedRefresh).toEqual(refreshed);
  expect(calls).toBe(2);
});

test('Stripe webhook health reports all required events when the enabled endpoint is missing', async () => {
  const status = await getStripeWebhookHealth(createStripeClient([]), 20_000);

  expect(status.state).toBe('missing_endpoint');
  expect(status.missingEvents).toEqual([...STRIPE_WEBHOOK_EVENTS]);
});

test('Stripe webhook health searches later endpoint pages', async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `we_${index}`,
    url: `https://other-${index}.example/webhook`,
    status: 'enabled',
    enabled_events: [...STRIPE_WEBHOOK_EVENTS],
  }));
  const requests: Array<string | undefined> = [];
  const client = {
    webhookEndpoints: {
      list: async (params: { starting_after?: string }) => {
        requests.push(params.starting_after);
        return requests.length === 1
          ? { data: firstPage, has_more: true }
          : { data: [{ id: 'we_dkrypt', url: 'https://dkrypt.example/v1/stripe/webhook', status: 'enabled', enabled_events: [...STRIPE_WEBHOOK_EVENTS] }], has_more: false };
      },
    },
  } as unknown as Stripe;

  const status = await getStripeWebhookHealth(client, 25_000);

  expect(status.state).toBe('ready');
  expect(requests).toEqual([undefined, 'we_99']);
});

test('Stripe webhook health degrades without failing provider status when Stripe is unavailable', async () => {
  const client = {
    webhookEndpoints: {
      list: async () => { throw new Error('request failed'); },
    },
  } as unknown as Stripe;

  const status = await getStripeWebhookHealth(client, 30_000);

  expect(status).toMatchObject({ state: 'unavailable', checkedAt: new Date(30_000).toISOString(), missingEvents: [] });
});

test('Stripe webhook health does not reveal endpoint events when no Stripe key is configured', async () => {
  config.stripeSecretKey = '';
  const client = createStripeClient([]);

  const status = await getStripeWebhookHealth(client, 40_000);

  expect(status.state).toBe('not_configured');
  expect(status.missingEvents).toEqual([]);
  expect(status.checkedAt).toBeUndefined();
});

test('Stripe webhook synchronization updates the existing endpoint events without rotating its secret', async () => {
  const endpoint = {
    id: 'we_dkrypt',
    url: 'https://dkrypt.example/v1/stripe/webhook',
    status: 'enabled',
    enabled_events: ['checkout.session.completed'],
    secret: 'whsec_preserved',
  };
  const updates: Array<{ id: string; params: Record<string, unknown> }> = [];
  const client = {
    webhookEndpoints: {
      list: async () => ({ data: [endpoint], has_more: false }),
      update: async (id: string, params: Record<string, unknown>) => {
        updates.push({ id, params });
        Object.assign(endpoint, params);
        return endpoint;
      },
      create: async () => { throw new Error('synchronization must not create endpoints'); },
    },
  } as unknown as Stripe;

  const status = await syncStripeWebhookEvents(client);

  expect(status).toMatchObject({ state: 'ready', missingEvents: [] });
  expect(updates).toEqual([{ id: 'we_dkrypt', params: { enabled_events: [...STRIPE_WEBHOOK_EVENTS] } }]);
  expect(endpoint.secret).toBe('whsec_preserved');
});

test('Stripe webhook synchronization refuses to create an endpoint when none is enabled', async () => {
  let updateCalls = 0;
  let createCalls = 0;
  const client = {
    webhookEndpoints: {
      list: async () => ({ data: [], has_more: false }),
      update: async () => { updateCalls += 1; },
      create: async () => { createCalls += 1; },
    },
  } as unknown as Stripe;

  await expect(syncStripeWebhookEvents(client)).rejects.toBeInstanceOf(StripeWebhookEndpointNotFoundError);
  expect(updateCalls).toBe(0);
  expect(createCalls).toBe(0);
});
