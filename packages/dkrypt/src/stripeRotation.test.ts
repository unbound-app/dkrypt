import { afterEach, beforeEach, expect, test } from 'bun:test';
import Stripe from 'stripe';
import { config } from '#config.js';
import { stripeRequest } from '#stripe.js';

const originalCurrentKey = config.stripeSecretKey;
const originalPreviousKey = config.stripeSecretKeyPrevious;

beforeEach(() => {
  config.stripeSecretKey = 'sk_test_current_key_for_rotation_test';
  config.stripeSecretKeyPrevious = 'sk_test_previous_key_for_rotation_test';
});

afterEach(() => {
  config.stripeSecretKey = originalCurrentKey;
  config.stripeSecretKeyPrevious = originalPreviousKey;
});

function authenticationError(statusCode: number): Stripe.errors.StripeAuthenticationError {
  return new Stripe.errors.StripeAuthenticationError({ statusCode, message: 'invalid API key' });
}

function configuredKey(client: Stripe): string {
  return (client as unknown as { _authenticator: { _apiKey: string } })._authenticator._apiKey;
}

test('Stripe retries an explicit current-key authentication rejection with the previous key', async () => {
  const attemptedKeys: string[] = [];

  const result = await stripeRequest(async (client) => {
    const key = configuredKey(client);
    attemptedKeys.push(key);
    if (key === config.stripeSecretKey) throw authenticationError(401);
    return 'success';
  });

  expect(result).toBe('success');
  expect(attemptedKeys).toEqual([config.stripeSecretKey, config.stripeSecretKeyPrevious]);
});

test('Stripe does not retry network failures or non-authentication errors', async () => {
  const failures = [
    new Stripe.errors.StripeConnectionError({ message: 'network timeout' }),
    new Stripe.errors.StripePermissionError({ statusCode: 403, message: 'permission denied' }),
  ];

  for (const failure of failures) {
    const attemptedKeys: string[] = [];

    await expect(stripeRequest(async (client) => {
      attemptedKeys.push(configuredKey(client));
      throw failure;
    })).rejects.toBe(failure);

    expect(attemptedKeys).toEqual([config.stripeSecretKey]);
  }
});

test('Stripe does not use a previous key from another mode', async () => {
  config.stripeSecretKeyPrevious = 'sk_live_previous_key_for_rotation_test';
  const attemptedKeys: string[] = [];

  await expect(stripeRequest(async (client) => {
    attemptedKeys.push(configuredKey(client));
    throw authenticationError(401);
  })).rejects.toBeInstanceOf(Stripe.errors.StripeAuthenticationError);

  expect(attemptedKeys).toEqual([config.stripeSecretKey]);
});

test('Stripe does not retry when no previous key is configured', async () => {
  config.stripeSecretKeyPrevious = '';
  const attemptedKeys: string[] = [];

  await expect(stripeRequest(async (client) => {
    attemptedKeys.push(configuredKey(client));
    throw authenticationError(401);
  })).rejects.toBeInstanceOf(Stripe.errors.StripeAuthenticationError);

  expect(attemptedKeys).toEqual([config.stripeSecretKey]);
});
