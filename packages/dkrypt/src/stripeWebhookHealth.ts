import type Stripe from 'stripe';
import { config } from '#config.js';
import { log } from '#logger.js';
import { stripeRequest } from '#stripe.js';
import { STRIPE_WEBHOOK_EVENTS } from '#stripeWebhookEvents.js';

const CACHE_TTL_MS = 60_000;
const ERROR_CACHE_TTL_MS = 15_000;
const API_TIMEOUT_MS = 5_000;
const endpointPath = '/v1/stripe/webhook';

export type StripeWebhookHealthState = 'ready' | 'missing_endpoint' | 'missing_events' | 'unavailable' | 'not_configured';

export interface StripeWebhookHealth {
  state: StripeWebhookHealthState;
  endpointUrl: string;
  requiredEvents: string[];
  missingEvents: string[];
  checkedAt?: string;
}

let cachedStatus: { endpointUrl: string; expiresAt: number; status: StripeWebhookHealth } | undefined;

function cloneStatus(status: StripeWebhookHealth): StripeWebhookHealth {
  return { ...status, requiredEvents: [...status.requiredEvents], missingEvents: [...status.missingEvents] };
}

export function clearStripeWebhookHealthCache(): void {
  cachedStatus = undefined;
}

export async function getStripeWebhookHealth(client: Stripe | undefined, now = Date.now(), forceRefresh = false): Promise<StripeWebhookHealth> {
  const endpointUrl = new URL(endpointPath, config.publicBaseUrl).toString();
  if (!config.stripeSecretKey) {
    return { state: 'not_configured', endpointUrl, requiredEvents: [...STRIPE_WEBHOOK_EVENTS], missingEvents: [] };
  }
  if (!forceRefresh && cachedStatus?.endpointUrl === endpointUrl && cachedStatus.expiresAt > now) return cloneStatus(cachedStatus.status);

  const checkedAt = new Date(now).toISOString();
  try {
    const requestOptions = { timeout: API_TIMEOUT_MS, maxNetworkRetries: 0 };
    let startingAfter: string | undefined;
    let endpoint: Stripe.WebhookEndpoint | undefined;

    while (true) {
      const parameters = { limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) };
      const page = client
        ? await client.webhookEndpoints.list(parameters, requestOptions)
        : await stripeRequest((activeClient) => activeClient.webhookEndpoints.list(parameters, requestOptions));
      endpoint = page.data.find((candidate) => candidate.url === endpointUrl && candidate.status === 'enabled');
      if (endpoint || !page.has_more || page.data.length === 0) break;
      startingAfter = page.data.at(-1)?.id;
      if (!startingAfter) break;
    }

    const configuredEvents = new Set(endpoint?.enabled_events ?? []);
    const missingEvents = configuredEvents.has('*') ? [] : STRIPE_WEBHOOK_EVENTS.filter((event) => !configuredEvents.has(event));
    const status: StripeWebhookHealth = {
      state: !endpoint ? 'missing_endpoint' : missingEvents.length > 0 ? 'missing_events' : 'ready',
      endpointUrl,
      requiredEvents: [...STRIPE_WEBHOOK_EVENTS],
      missingEvents: endpoint ? missingEvents : [...STRIPE_WEBHOOK_EVENTS],
      checkedAt,
    };
    cachedStatus = { endpointUrl, expiresAt: now + CACHE_TTL_MS, status };
    return cloneStatus(status);
  } catch (error) {
    log.warn('Stripe webhook readiness check failed', { error: String(error) });
    const status: StripeWebhookHealth = {
      state: 'unavailable',
      endpointUrl,
      requiredEvents: [...STRIPE_WEBHOOK_EVENTS],
      missingEvents: [],
      checkedAt,
    };
    cachedStatus = { endpointUrl, expiresAt: now + ERROR_CACHE_TTL_MS, status };
    return cloneStatus(status);
  }
}
