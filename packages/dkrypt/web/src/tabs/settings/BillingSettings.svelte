<script lang="ts">
  import { CreditCard, LoaderCircle, RefreshCw, WalletCards } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchBillingProviderStatus, fetchBillingSubscriptions, type BillingManagerSubscription, type BillingProviderStatus } from '#lib/api';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';
  import type { BadgeVariant } from '#lib/components/ui/variants';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageBilling));
  let subscriptions = $state<BillingManagerSubscription[]>([]);
  let providerStatus = $state<BillingProviderStatus | null>(null);
  let loading = $state(true);
  let refreshing = $state(false);
  let search = $state('');
  let statusFilter = $state('');
  let providerFilter = $state('');

  async function load(): Promise<void> {
    refreshing = true;
    try {
      const [ledger, status] = await Promise.all([
        fetchBillingSubscriptions({ q: search, provider: providerFilter || undefined, status: statusFilter || undefined }),
        canManage ? fetchBillingProviderStatus() : Promise.resolve(null),
      ]);
      subscriptions = ledger.subscriptions;
      providerStatus = status;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load billing subscriptions", 'error');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function statusVariant(status: string): BadgeVariant {
    if (status === 'active' || status === 'trialing') return 'success';
    if (status === 'past_due') return 'warning';
    if (status === 'cancelled' || status === 'canceled' || status === 'unpaid') return 'destructive';
    return 'secondary';
  }

  function providerLabel(provider: BillingManagerSubscription['provider']): string {
    return provider === 'nowpayments' ? 'Crypto · NOWPayments' : provider === 'stripe' ? 'Stripe' : 'Historical record';
  }

  function money(value?: number, currency = 'EUR'): string {
    if (value === undefined) return '—';
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value);
  }

  function date(value?: string): string {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(parsed);
  }

  function short(value?: string): string {
    if (!value) return '—';
    return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
  }

  onMount(() => void load());
</script>

<div class="flex flex-col gap-4">
  <Card title="Billing subscriptions">
    <div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span class="flex items-center gap-2"><CreditCard class="h-4 w-4" /> View active, pending, failed, and canceled member subscriptions across billing providers.</span><Button size="sm" variant="secondary" loading={refreshing} onclick={() => void load()}><RefreshCw class="h-4 w-4" /> Refresh</Button></div>
    <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_10rem_10rem_auto]">
      <Input bind:value={search} placeholder="Search member, email, plan, or subscription" aria-label="Search subscriptions" />
      <select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={providerFilter} onchange={() => void load()} aria-label="Filter by provider"><option value="">All providers</option><option value="stripe">Stripe</option><option value="nowpayments">Crypto</option><option value="legacy">Historical records</option></select>
      <select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={statusFilter} onchange={() => void load()} aria-label="Filter by status"><option value="">All statuses</option><option value="active">Active</option><option value="past_due">Past due</option><option value="cancelled">Canceled</option></select>
      <Button variant="secondary" onclick={() => void load()}><RefreshCw class="h-4 w-4" /> Apply</Button>
    </div>
  </Card>

  {#if providerStatus}
    <div class="grid gap-3 md:grid-cols-2">
      <Card title="Stripe"><div class="flex items-center justify-between gap-3 text-sm"><span>{providerStatus.stripe.enabled ? 'Ready for card and bank checkout' : 'Not configured'}</span><Badge variant={providerStatus.stripe.enabled ? 'success' : 'secondary'}>{providerStatus.stripe.environment}</Badge></div></Card>
      <Card title="Crypto · NOWPayments"><div class="flex items-center justify-between gap-3 text-sm"><span>{!providerStatus.crypto.enabled ? 'Disabled for new checkouts' : providerStatus.crypto.ready ? 'Ready for EUR-priced crypto invoices' : providerStatus.crypto.issues[0] ?? 'Not ready'}</span><Badge variant={providerStatus.crypto.enabled && providerStatus.crypto.ready ? 'success' : 'warning'}>{providerStatus.crypto.environment}</Badge></div><div class="mt-2 text-xs text-muted">Crypto checkout is separate from Stripe and does not collect billing information.</div></Card>
    </div>
  {/if}

  <Card>
    {#if loading}
      <div class="flex min-h-32 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
    {:else if subscriptions.length === 0}
      <EmptyState icon={WalletCards} message="No subscriptions match these filters." />
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[860px] text-left text-sm">
          <thead class="border-b border-border text-xs text-muted"><tr><th class="px-2 py-3 font-medium">Member</th><th class="px-2 py-3 font-medium">Plan</th><th class="px-2 py-3 font-medium">Provider</th><th class="px-2 py-3 font-medium">Status</th><th class="px-2 py-3 font-medium">Renewal</th><th class="px-2 py-3 font-medium">Payment details</th><th class="px-2 py-3 font-medium">Last charge</th></tr></thead>
          <tbody class="divide-y divide-border/70">
            {#each subscriptions as subscription (subscription.provider + subscription.subscriptionId)}
              <tr class="align-top"><td class="px-2 py-3"><div class="font-medium">{subscription.user?.displayName ?? subscription.user?.id ?? 'Unknown member'}</div><div class="text-xs text-muted">{subscription.user?.email ?? subscription.user?.username ?? subscription.user?.id ?? '—'}</div></td><td class="px-2 py-3"><div class="font-medium">{subscription.plan.name ?? subscription.plan.id}</div><div class="text-xs text-muted">{money(subscription.plan.amount, subscription.plan.currency)}{#if subscription.interval} · {subscription.interval}{/if}</div><div class="max-w-32 truncate font-mono text-[10px] text-muted" title={subscription.priceId}>{subscription.priceId}</div></td><td class="px-2 py-3"><Badge variant="secondary">{providerLabel(subscription.provider)}</Badge><div class="mt-1 max-w-28 truncate font-mono text-[10px] text-muted" title={subscription.subscriptionId}>{short(subscription.subscriptionId)}</div><div class="max-w-28 truncate font-mono text-[10px] text-muted" title={subscription.customerId}>{short(subscription.customerId)}</div></td><td class="px-2 py-3"><Badge variant={statusVariant(subscription.status)}>{subscription.status.replace('_', ' ')}</Badge>{#if subscription.lastCharge.graceUntil}<div class="mt-1 text-[11px] text-muted">Grace until {date(subscription.lastCharge.graceUntil)}</div>{/if}</td><td class="px-2 py-3 text-muted">{date(subscription.nextBilledAt)}</td><td class="px-2 py-3 text-xs text-muted">{#if subscription.crypto}<div>{subscription.crypto.asset ?? 'Token'} · {subscription.crypto.chain ?? 'Base'}</div><div class="font-mono" title={subscription.crypto.walletAddress}>{short(subscription.crypto.walletAddress)}</div>{:else}<div>Provider-managed payment</div>{/if}{#if subscription.tax}<div class="mt-1">Tax {subscription.tax.status}{#if subscription.tax.country} · {subscription.tax.country}{/if}</div>{/if}</td><td class="px-2 py-3 text-xs text-muted"><div>{subscription.lastCharge.status ?? '—'} · {date(subscription.lastCharge.at)}</div>{#if subscription.lastCharge.txHash}<div class="font-mono" title={subscription.lastCharge.txHash}>{short(subscription.lastCharge.txHash)}</div>{/if}{#if subscription.lastCharge.failureReason}<div class="max-w-36 text-err">{subscription.lastCharge.failureReason}</div>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </Card>
</div>
