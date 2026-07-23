<script lang="ts">
  import { initializePaddle, type Environments, type Paddle } from '@paddle/paddle-js';
  import { Check, Gauge, KeyRound, LoaderCircle, LockKeyhole, Zap } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import { refreshSession, sessionState } from '../lib/session.svelte';
  import { showToast } from '../lib/ui.svelte';

  type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api';

  interface Plan {
    id: Exclude<PlanId, 'viewer'>;
    name: string;
    description: string;
    amount: number;
    currency: string;
    priceId: string;
  }

  interface Entitlement {
    planId: PlanId;
    decrypt: boolean;
    api: boolean;
    priority: number;
    status?: string;
    subscriptionId?: string;
    nextBilledAt?: string;
    scheduledChangeAction?: string;
    scheduledChangeAt?: string;
  }

  interface BillingData {
    enabled: boolean;
    environment: Environments;
    clientToken?: string;
    plans: Plan[];
    customerId?: string;
    customerEmail?: string;
    entitlement: Entitlement;
  }

  let billing = $state<BillingData | undefined>();
  let paddle = $state<Paddle | undefined>();
  let loading = $state(true);
  let openingPlan = $state<PlanId | undefined>();
  let formattedPrices = $state<Record<string, string>>({});

  async function loadBilling(): Promise<void> {
    const response = await fetch('/v1/billing');
    if (!response.ok) throw new Error('billing unavailable');
    billing = (await response.json()) as BillingData;
  }

  async function initializeBilling(): Promise<void> {
    loading = true;
    try {
      await loadBilling();
      if (!billing?.enabled || !billing.clientToken) return;
      paddle = await initializePaddle({
        token: billing.clientToken,
        environment: billing.environment,
        eventCallback: (event) => {
          if (event.name === 'checkout.completed') {
            showToast('Payment completed. Activating your subscription…', 'success');
            setTimeout(() => void refreshAfterCheckout(), 1500);
          }
        },
        checkout: {
          settings: {
            variant: 'one-page',
            successUrl: `${location.origin}/?tab=billing&checkout=success`,
          },
        },
      });
      if (!paddle) return;
      const preview = await paddle.PricePreview({
        items: billing.plans.map((plan) => ({ priceId: plan.priceId, quantity: 1 })),
        currencyCode: 'EUR',
      });
      formattedPrices = Object.fromEntries(
        preview.data.details.lineItems.map((item) => [item.price.id, item.formattedTotals.total]),
      );
    } catch {
      showToast("Couldn't load billing right now", 'error');
    } finally {
      loading = false;
    }
  }

  async function refreshAfterCheckout(): Promise<void> {
    await loadBilling();
    await refreshSession();
  }

  async function waitForActivation(): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await refreshAfterCheckout();
      if (billing?.entitlement.planId !== 'viewer') return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  async function manageSubscription(): Promise<void> {
    const response = await fetch('/v1/billing/portal', { method: 'POST' });
    const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!response.ok || !data.url) {
      showToast(data.error ?? "Couldn't open the billing portal", 'error');
      return;
    }
    location.assign(data.url);
  }

  async function changePlan(plan: Plan): Promise<void> {
    openingPlan = plan.id;
    try {
      const response = await fetch('/v1/billing/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        showToast(data.error ?? 'Plan change failed', 'error');
        return;
      }
      showToast('Plan change accepted. Paddle is updating your access…', 'success');
      setTimeout(() => void refreshAfterCheckout(), 1000);
    } finally {
      openingPlan = undefined;
    }
  }

  function choosePlan(plan: Plan): void {
    if (billing?.entitlement.subscriptionId) {
      void changePlan(plan);
      return;
    }
    if (!paddle || !billing || !sessionState.sub) return;
    openingPlan = plan.id;
    paddle.Checkout.open({
      items: [{ priceId: plan.priceId, quantity: 1 }],
      customData: { dkrypt_user_id: sessionState.sub },
      customer: billing.customerId
        ? { id: billing.customerId }
        : billing.customerEmail
          ? { email: billing.customerEmail }
          : undefined,
      settings: {
        variant: 'one-page',
        successUrl: `${location.origin}/?tab=billing&checkout=success`,
      },
    });
    openingPlan = undefined;
  }

  function fallbackPrice(plan: Plan): string {
    return new Intl.NumberFormat('en', { style: 'currency', currency: plan.currency }).format(plan.amount);
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
  }

  onMount(() => {
    void initializeBilling().then(() => {
      if (new URLSearchParams(location.search).get('checkout') === 'success') void waitForActivation();
    });
  });
</script>

<div class="flex flex-col gap-4">
  <Card>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="mb-1 flex items-center gap-2">
          <h2 class="text-lg font-semibold">Choose your dkrypt plan</h2>
          {#if billing?.environment === 'sandbox'}
            <Badge variant="warning">Sandbox</Badge>
          {/if}
        </div>
        <p class="max-w-2xl text-sm text-muted">
          Every account starts as a viewer. Paid access is activated from signed Paddle webhooks after checkout.
        </p>
      </div>
      {#if billing}
        <div class="flex items-center gap-2">
          <div class="rounded-lg border border-border bg-bg px-3 py-2 text-right">
            <div class="text-xs text-muted">Current plan</div>
            <div class="font-semibold capitalize">{billing.entitlement.planId.replace('_', ' ')}</div>
            {#if billing.entitlement.status}
              <div class="text-xs text-muted">{billing.entitlement.status.replace('_', ' ')}</div>
            {/if}
          </div>
          {#if billing.customerId}
            <Button variant="secondary" onclick={() => void manageSubscription()}>Manage billing</Button>
          {/if}
        </div>
      {/if}
    </div>
  </Card>

  {#if loading}
    <Card class="flex min-h-48 items-center justify-center">
      <LoaderCircle class="h-6 w-6 animate-spin text-muted" />
    </Card>
  {:else if !billing?.enabled}
    <Card class="py-12 text-center">
      <LockKeyhole class="mx-auto mb-3 h-8 w-8 text-muted" />
      <div class="font-medium">Billing is not configured</div>
      <div class="mt-1 text-sm text-muted">Add the Paddle environment values to enable checkout.</div>
    </Card>
  {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
      {#each billing.plans as plan (plan.id)}
        <Card class={plan.id === 'priority_api' ? 'border-accent shadow-lg shadow-accent/10' : ''}>
          <div class="flex h-full min-h-72 flex-col">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <h3 class="text-base font-semibold">{plan.name}</h3>
                <p class="mt-1 text-sm text-muted">{plan.description}</p>
              </div>
              {#if plan.id === 'priority' || plan.id === 'priority_api'}
                <Zap class="h-5 w-5 shrink-0 text-accent" />
              {:else if plan.id === 'api'}
                <KeyRound class="h-5 w-5 shrink-0 text-accent" />
              {:else}
                <Gauge class="h-5 w-5 shrink-0 text-accent" />
              {/if}
            </div>

            <div class="mb-5">
              <span class="text-3xl font-semibold">{formattedPrices[plan.priceId] ?? fallbackPrice(plan)}</span>
              <span class="text-sm text-muted">/month</span>
            </div>

            <div class="mb-6 flex flex-1 flex-col gap-2 text-sm">
              <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> Dashboard decrypts</div>
              <div class="flex items-center gap-2">
                <Check class="h-4 w-4 text-ok" />
                {plan.id === 'api' || plan.id === 'priority_api' ? 'API key access' : 'No API key access'}
              </div>
              <div class="flex items-center gap-2">
                <Check class="h-4 w-4 text-ok" />
                {plan.id === 'priority' || plan.id === 'priority_api' ? 'High queue priority' : 'Standard queue priority'}
              </div>
            </div>

            <Button
              class="w-full"
              variant={plan.id === 'priority_api' ? 'default' : 'secondary'}
              disabled={billing.entitlement.planId === plan.id || (!paddle && !billing.entitlement.subscriptionId)}
              loading={openingPlan === plan.id}
              onclick={() => choosePlan(plan)}
            >
              {billing.entitlement.planId === plan.id
                ? 'Current plan'
                : billing.entitlement.subscriptionId
                  ? `Switch to ${plan.name}`
                  : 'Subscribe'}
            </Button>
          </div>
        </Card>
      {/each}
    </div>

    {#if billing.entitlement.scheduledChangeAt}
      <Card>
        <div class="text-sm">
          Your subscription has a {billing.entitlement.scheduledChangeAction ?? 'scheduled'} change on
          {formatDate(billing.entitlement.scheduledChangeAt)}.
        </div>
      </Card>
    {:else if billing.entitlement.nextBilledAt}
      <div class="text-center text-xs text-muted">Next billing date: {formatDate(billing.entitlement.nextBilledAt)}</div>
    {/if}
  {/if}
</div>
