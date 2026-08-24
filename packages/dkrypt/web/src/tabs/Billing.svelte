<script lang="ts">
  import {
    Check,
    CircleCheck,
    CircleX,
    ExternalLink,
    Gauge,
    KeyRound,
    LoaderCircle,
    LockKeyhole,
    RefreshCw,
    ShieldCheck,
    X,
    Zap,
  } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import LegalLinks from '#components/LegalLinks.svelte';
  import { refreshSession } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';
  import type { BadgeVariant } from '#lib/components/ui/variants';

  type PlanId = 'viewer' | 'regular' | 'priority' | 'api' | 'priority_api';
  type CheckoutState = 'success' | 'cancelled' | undefined;
  type ActivationStatus = 'idle' | 'checking' | 'active' | 'pending';

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
    provider: 'stripe';
    environment: 'test' | 'live';
    managedPayments: boolean;
    missingConfiguration: string[];
    plans: Plan[];
    customerId?: string;
    customerEmail?: string;
    legacyBilling: boolean;
    entitlement: Entitlement;
  }

  let billing = $state<BillingData | undefined>();
  let loading = $state(true);
  let loadError = $state(false);
  let openingPlan = $state<PlanId | undefined>();
  let openingPortal = $state(false);
  let activationStatus = $state<ActivationStatus>('idle');
  let checkoutIdempotencyKey = $state<string | undefined>();
  let checkoutIdempotencyPlan = $state<PlanId | undefined>();
  let checkoutState = $state<CheckoutState>(new URLSearchParams(location.search).get('checkout') as CheckoutState);

  async function loadBilling(): Promise<void> {
    const response = await fetch('/v1/billing');
    if (!response.ok) throw new Error('billing unavailable');
    billing = (await response.json()) as BillingData;
  }

  async function initializeBilling(): Promise<void> {
    loading = true;
    loadError = false;
    try {
      await loadBilling();
    } catch {
      loadError = true;
      showToast("Couldn't load billing right now", 'error');
    } finally {
      loading = false;
    }
  }

  async function refreshAfterCheckout(): Promise<void> {
    try {
      await loadBilling();
      await refreshSession();
    } catch {}
  }

  async function waitForActivation(): Promise<void> {
    activationStatus = 'checking';
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await refreshAfterCheckout();
      if (billing?.entitlement.planId !== 'viewer') {
        activationStatus = 'active';
        showToast('Subscription active. Your paid features are ready.', 'success');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1250));
    }
    activationStatus = 'pending';
  }

  async function manageSubscription(): Promise<void> {
    openingPortal = true;
    try {
      const response = await fetch('/v1/billing/portal', { method: 'POST' });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        showToast(data.error ?? "Couldn't open the billing portal", 'error');
        return;
      }
      location.assign(data.url);
    } finally {
      openingPortal = false;
    }
  }

  async function startCheckout(plan: Plan): Promise<void> {
    openingPlan = plan.id;
    if (checkoutIdempotencyPlan !== plan.id) {
      checkoutIdempotencyKey = crypto.randomUUID();
      checkoutIdempotencyPlan = plan.id;
    }
    const idempotencyKey = checkoutIdempotencyKey;
    if (!idempotencyKey) {
      openingPlan = undefined;
      showToast("Couldn't start checkout", 'error');
      return;
    }
    try {
      const response = await fetch('/v1/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!response.ok || !data.url) {
        showToast(data.error ?? "Couldn't start checkout", 'error');
        return;
      }
      location.assign(data.url);
    } finally {
      openingPlan = undefined;
    }
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
      showToast('Plan updated. Your access is refreshing…', 'success');
      await refreshAfterCheckout();
    } finally {
      openingPlan = undefined;
    }
  }

  function choosePlan(plan: Plan): void {
    if (openingPlan) return;
    if (billing?.entitlement.subscriptionId) {
      void changePlan(plan);
      return;
    }
    void startCheckout(plan);
  }

  function fallbackPrice(plan: Plan): string {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: plan.currency }).format(plan.amount);
  }

  function formatDate(value: string): string {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(value));
  }

  function planLabel(planId: PlanId): string {
    return planId === 'viewer' ? 'Viewer' : planId.replace('_', ' ');
  }

  function statusVariant(status?: string): BadgeVariant {
    if (status === 'active' || status === 'trialing') return 'success';
    if (status === 'past_due' || status === 'incomplete') return 'warning';
    if (status === 'canceled' || status === 'unpaid') return 'destructive';
    return 'secondary';
  }

  function statusLabel(status?: string): string {
    return status ? status.replace('_', ' ') : 'Not subscribed';
  }

  onMount(() => {
    void initializeBilling().then(() => {
      if (checkoutState === 'success') void waitForActivation();
    });
  });
</script>

<div class="flex flex-col gap-4">
  {#if checkoutState === 'success'}
    <div class="flex items-start gap-3 rounded-[1.2rem] border border-ok/30 bg-ok/10 px-4 py-3 text-sm" aria-live="polite">
      <CircleCheck class="mt-0.5 h-5 w-5 shrink-0 text-ok" />
      <div>
        <div class="font-semibold text-ok">Checkout completed</div>
        <p class="mt-1 text-muted">
          {#if activationStatus === 'active'}
            Your subscription is active and paid features are ready.
          {:else if activationStatus === 'pending'}
            Stripe is still confirming your subscription. Access will remain unchanged until the webhook arrives.
            <Button class="mt-3" size="sm" variant="secondary" onclick={() => void waitForActivation()}>
              <RefreshCw class="h-4 w-4" /> Check again
            </Button>
          {:else}
            Stripe is confirming your subscription. This usually takes a few seconds.
          {/if}
        </p>
      </div>
    </div>
  {:else if checkoutState === 'cancelled'}
    <div class="flex items-start gap-3 rounded-[1.2rem] border border-border bg-panel-muted/40 px-4 py-3 text-sm" aria-live="polite">
      <CircleX class="mt-0.5 h-5 w-5 shrink-0 text-muted" />
      <div>
        <div class="font-semibold">Checkout canceled</div>
        <p class="mt-1 text-muted">No charge was made. Choose a plan whenever you’re ready.</p>
      </div>
    </div>
  {/if}

  <Card>
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div class="mb-1 flex flex-wrap items-center gap-2">
          <h2 class="text-lg font-semibold">Choose your dkrypt plan</h2>
          {#if billing?.enabled}
          <Badge variant="outline">Stripe Managed Payments {billing.environment === 'test' ? 'test mode' : 'live'}</Badge>
          {/if}
        </div>
        <p class="max-w-2xl text-sm text-muted">
          Subscribe to unlock authorized decrypt processing, API access, and higher queue priority. Stripe hosts checkout, handles tax and local-currency presentation, and returns you here when payment is complete.
        </p>
      </div>
      {#if billing}
        <div class="flex flex-wrap items-center gap-2">
          <div class="rounded-xl border border-border bg-bg/60 px-3 py-2 text-right">
            <div class="text-xs text-muted">Current plan</div>
            <div class="font-semibold capitalize">{planLabel(billing.entitlement.planId)}</div>
            <Badge variant={statusVariant(billing.entitlement.status)} class="mt-1">{statusLabel(billing.entitlement.status)}</Badge>
          </div>
          {#if billing.customerId}
            <Button variant="secondary" loading={openingPortal} onclick={() => void manageSubscription()}>
              <ExternalLink class="h-4 w-4" />
              Manage billing
            </Button>
          {/if}
        </div>
      {/if}
    </div>
  </Card>

  {#if billing?.legacyBilling}
    <Card class="border-accent/40 bg-accent/5">
      <div class="text-sm">
        <div class="font-medium">Previous billing record needs review</div>
        <div class="mt-1 text-muted">Your previous payment-provider record was kept for reconciliation, but it does not grant Stripe access. Contact support before starting a new subscription so the account is not charged twice.</div>
      </div>
    </Card>
  {/if}

  {#if loading}
    <Card class="flex min-h-48 items-center justify-center">
      <LoaderCircle class="h-6 w-6 animate-spin text-muted" />
    </Card>
  {:else if loadError}
    <Card class="py-12 text-center">
      <CircleX class="mx-auto mb-3 h-8 w-8 text-err" />
      <div class="font-medium">Billing could not be loaded</div>
      <div class="mt-1 text-sm text-muted">Check your connection and try again.</div>
      <Button class="mt-5" variant="secondary" onclick={() => void initializeBilling()}>Try again</Button>
    </Card>
  {:else if !billing?.enabled}
    <Card class="py-12 text-center">
      <LockKeyhole class="mx-auto mb-3 h-8 w-8 text-muted" />
      <div class="font-medium">Billing is not configured</div>
      <div class="mx-auto mt-1 max-w-md text-sm text-muted">Stripe checkout is unavailable until an administrator completes the server configuration. No payment details are collected while billing is disabled.</div>
      {#if billing}
        <div class="mx-auto mt-4 flex max-w-xl flex-wrap justify-center gap-2" aria-label="Missing Stripe configuration">
          {#each billing.missingConfiguration as name (name)}
            <code class="rounded-lg border border-border bg-bg/70 px-2.5 py-1 text-xs text-muted">{name}</code>
          {/each}
        </div>
      {/if}
    </Card>
  {:else}
    <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-4">
      {#each billing.plans as plan (plan.id)}
        {@const current = billing.entitlement.planId === plan.id}
        {@const highlighted = plan.id === 'priority_api'}
        <Card class={highlighted ? 'border-accent shadow-lg shadow-accent/10' : current ? 'border-ok/50' : ''}>
          <div class="flex h-full min-h-80 flex-col">
            <div class="mb-4 flex items-start justify-between gap-3">
              <div>
                <div class="flex flex-wrap items-center gap-2">
                  <h3 class="text-base font-semibold">{plan.name}</h3>
                  {#if highlighted}<Badge>Best value</Badge>{/if}
                  {#if current}<Badge variant="success">Current</Badge>{/if}
                </div>
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
              <span class="text-3xl font-semibold">{fallbackPrice(plan)}</span>
              <span class="text-sm text-muted">/month</span>
            </div>

            <div class="mb-6 flex flex-1 flex-col gap-2 text-sm">
              <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> Dashboard decrypts</div>
              {#if plan.id === 'api' || plan.id === 'priority_api'}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> API key access</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> API key access</div>
              {/if}
              {#if plan.id === 'priority' || plan.id === 'priority_api'}
                <div class="flex items-center gap-2"><Check class="h-4 w-4 text-ok" /> High queue priority</div>
              {:else}
                <div class="flex items-center gap-2 text-muted"><X class="h-4 w-4" /> High queue priority</div>
              {/if}
              <div class="mt-2 flex items-center gap-2 text-xs text-muted"><ShieldCheck class="h-4 w-4 text-accent" /> Secure Stripe checkout</div>
            </div>

            <Button
              class="w-full"
              variant={highlighted ? 'default' : 'secondary'}
              disabled={current || openingPlan !== undefined || (!billing.enabled && !billing.entitlement.subscriptionId)}
              loading={openingPlan === plan.id}
              onclick={() => choosePlan(plan)}
            >
              {current ? 'Current plan' : billing.entitlement.subscriptionId ? `Switch to ${plan.name}` : 'Subscribe'}
            </Button>
          </div>
        </Card>
      {/each}
    </div>

    {#if billing.entitlement.scheduledChangeAt}
      <Card>
        <div class="text-sm">
          Your subscription is scheduled to {billing.entitlement.scheduledChangeAction ?? 'change'} on
          {formatDate(billing.entitlement.scheduledChangeAt)}.
        </div>
      </Card>
    {:else if billing.entitlement.nextBilledAt}
      <div class="text-center text-xs text-muted">Next billing date: {formatDate(billing.entitlement.nextBilledAt)}</div>
    {/if}

    <Card class="text-center text-xs leading-5 text-muted">
      Plans renew monthly until canceled. Stripe Managed Payments shows the final amount and applicable tax before payment. Stripe and Link handle payment details, receipts, and transaction support; dkrypt never stores full card details.
      <div class="mt-3">
        <LegalLinks />
      </div>
    </Card>
  {/if}
</div>
