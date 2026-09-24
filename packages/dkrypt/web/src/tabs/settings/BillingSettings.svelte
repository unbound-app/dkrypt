<script lang="ts">
  import { AlertTriangle, CreditCard, LoaderCircle, RefreshCw, RotateCcw, ShieldAlert, WalletCards } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchBillingProviderStatus, fetchBillingSubscriptions, fetchBillingWebhookInbox, quarantineBillingWebhook, replayBillingWebhook, type BillingManagerSubscription, type BillingProviderStatus, type BillingWebhookInboxRecord } from '#lib/api';
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
  let planId = $state('');
  let statusFilter = $state('');
  let providerFilter = $state('');
  let from = $state('');
  let to = $state('');
  let wallet = $state('');
  let invoice = $state('');
  let total = $state(0);
  let nextCursor = $state<string | undefined>(undefined);
  let loadingMore = $state(false);
  let webhooks = $state<BillingWebhookInboxRecord[]>([]);
  let webhookLoading = $state(false);
  let webhookNextCursor = $state<string | undefined>(undefined);
  let webhookTotal = $state(0);
  let webhookAction = $state<string | undefined>(undefined);
  let webhookProviderFilter = $state('');
  let webhookStatusFilter = $state('');

  function subscriptionFilters(cursor?: string): Parameters<typeof fetchBillingSubscriptions>[0] {
    return { q: search || undefined, planId: planId || undefined, provider: providerFilter || undefined, status: statusFilter || undefined, from: from || undefined, to: to || undefined, wallet: wallet || undefined, invoice: invoice || undefined, cursor, limit: 50 };
  }

  async function load(): Promise<void> {
    refreshing = true;
    try {
      const [ledger, status] = await Promise.all([
        fetchBillingSubscriptions(subscriptionFilters()),
        canManage ? fetchBillingProviderStatus() : Promise.resolve(null),
      ]);
      subscriptions = ledger.subscriptions;
      total = ledger.total;
      nextCursor = ledger.nextCursor;
      providerStatus = status;
      if (canManage) await loadWebhooks();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load billing subscriptions", 'error');
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    try {
      const page = await fetchBillingSubscriptions(subscriptionFilters(nextCursor));
      subscriptions = [...subscriptions, ...page.subscriptions];
      total = page.total;
      nextCursor = page.nextCursor;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load more subscriptions", 'error');
    } finally {
      loadingMore = false;
    }
  }

  async function loadWebhooks(cursor?: string): Promise<void> {
    if (!canManage) return;
    webhookLoading = true;
    try {
      const page = await fetchBillingWebhookInbox({ provider: webhookProviderFilter || undefined, status: webhookStatusFilter || undefined, cursor, limit: 25 });
      webhooks = cursor ? [...webhooks, ...page.inbox] : page.inbox;
      webhookTotal = page.total;
      webhookNextCursor = page.nextCursor;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Couldn't load webhook inbox", 'error');
    } finally {
      webhookLoading = false;
    }
  }

  async function replayWebhook(record: BillingWebhookInboxRecord): Promise<void> {
    webhookAction = record.id;
    try {
      const result = await replayBillingWebhook(record.id);
      if (result.ok) await loadWebhooks();
    } finally {
      webhookAction = undefined;
    }
  }

  async function quarantineWebhook(record: BillingWebhookInboxRecord): Promise<void> {
    webhookAction = record.id;
    try {
      const result = await quarantineBillingWebhook(record.id, 'quarantined by manager');
      if (result.ok) await loadWebhooks();
    } finally {
      webhookAction = undefined;
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
    <details class="mt-3 rounded-lg border border-border/70 px-3 py-2">
      <summary class="cursor-pointer text-sm font-medium">More filters</summary>
      <div class="mt-3 grid gap-2 md:grid-cols-2 lg:grid-cols-5">
        <Input bind:value={planId} placeholder="Plan ID" aria-label="Filter by plan" />
        <Input bind:value={from} type="date" aria-label="Updated from" />
        <Input bind:value={to} type="date" aria-label="Updated through" />
        <Input bind:value={wallet} placeholder="Wallet address" aria-label="Filter by wallet" />
        <Input bind:value={invoice} placeholder="Invoice or payment ID" aria-label="Filter by invoice" />
      </div>
    </details>
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
              <tr class="align-top"><td class="px-2 py-3"><div class="font-medium">{subscription.user?.displayName ?? subscription.user?.id ?? 'Unknown member'}</div><div class="text-xs text-muted">{subscription.user?.email ?? subscription.user?.username ?? subscription.user?.id ?? '—'}</div></td><td class="px-2 py-3"><div class="font-medium">{subscription.plan.name ?? subscription.plan.id}</div><div class="text-xs text-muted">{money(subscription.plan.amount, subscription.plan.currency)}{#if subscription.interval} · {subscription.interval}{/if}</div><div class="max-w-32 truncate font-mono text-[10px] text-muted" title={subscription.priceId}>{subscription.priceId}</div></td><td class="px-2 py-3"><Badge variant="secondary">{providerLabel(subscription.provider)}</Badge><div class="mt-1 max-w-28 truncate font-mono text-[10px] text-muted" title={subscription.subscriptionId}>{short(subscription.subscriptionId)}</div><div class="max-w-28 truncate font-mono text-[10px] text-muted" title={subscription.customerId}>{short(subscription.customerId)}</div></td><td class="px-2 py-3"><Badge variant={statusVariant(subscription.status)}>{subscription.status.replace('_', ' ')}</Badge>{#if subscription.lastCharge.graceUntil}<div class="mt-1 text-[11px] text-muted">Grace until {date(subscription.lastCharge.graceUntil)}</div>{/if}</td><td class="px-2 py-3 text-muted">{date(subscription.nextBilledAt)}</td><td class="px-2 py-3 text-xs text-muted">{#if subscription.crypto}<div>{subscription.crypto.asset ?? 'Token'} · {subscription.crypto.chain ?? 'Base'}</div><div class="font-mono" title={subscription.crypto.walletAddress}>{short(subscription.crypto.walletAddress)}</div>{:else}<div>Provider-managed payment</div>{/if}{#if subscription.tax}<div class="mt-1">Tax {subscription.tax.status}{#if subscription.tax.country} · {subscription.tax.country}{/if}</div>{/if}</td><td class="px-2 py-3 text-xs text-muted"><div>{subscription.lastCharge.status ?? '—'} · {date(subscription.lastCharge.at)}</div>{#if subscription.lastCharge.txHash}<div class="font-mono" title={subscription.lastCharge.txHash}>{short(subscription.lastCharge.txHash)}</div>{/if}{#if subscription.lastCharge.failureReason}<div class="max-w-36 text-err">{subscription.lastCharge.failureReason}</div>{/if}{#if subscription.entitlementHistory?.length}<details class="mt-2"><summary class="cursor-pointer">History ({subscription.entitlementHistory.length})</summary><div class="mt-1 space-y-1">{#each subscription.entitlementHistory.slice(-5).reverse() as event}<div>{event.kind} · {date(event.at)}{#if event.detail} · {event.detail}{/if}</div>{/each}</div></details>{/if}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if nextCursor}
        <div class="mt-3 flex justify-center">
          <Button size="sm" variant="secondary" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - subscriptions.length)} older)</Button>
        </div>
      {/if}
    {/if}
  </Card>

  {#if canManage}
    <Card title="Webhook inbox">
      <div class="mb-4 flex flex-wrap items-center justify-between gap-2 text-sm text-muted"><span class="flex items-center gap-2"><ShieldAlert class="h-4 w-4" /> Signed payment events are retained for replay and quarantine.</span><div class="flex flex-wrap gap-2"><select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={webhookProviderFilter} onchange={() => void loadWebhooks()} aria-label="Filter webhook provider"><option value="">All providers</option><option value="stripe">Stripe</option><option value="nowpayments">Crypto</option></select><select class="rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text" bind:value={webhookStatusFilter} onchange={() => void loadWebhooks()} aria-label="Filter webhook status"><option value="">All statuses</option><option value="received">Received</option><option value="failed">Failed</option><option value="processed">Processed</option><option value="quarantined">Quarantined</option></select><Button size="sm" variant="secondary" loading={webhookLoading} onclick={() => void loadWebhooks()}><RefreshCw class="h-4 w-4" /> Refresh</Button></div></div>
      {#if webhookLoading && webhooks.length === 0}
        <div class="flex min-h-24 items-center justify-center"><LoaderCircle class="h-5 w-5 animate-spin text-muted" /></div>
      {:else if webhooks.length === 0}
        <EmptyState icon={ShieldAlert} message="No payment webhook events have been received." />
      {:else}
        <div class="overflow-x-auto">
          <table class="w-full min-w-[760px] text-left text-sm">
            <thead class="border-b border-border text-xs text-muted"><tr><th class="px-2 py-3 font-medium">Provider</th><th class="px-2 py-3 font-medium">Event</th><th class="px-2 py-3 font-medium">Status</th><th class="px-2 py-3 font-medium">Received</th><th class="px-2 py-3 font-medium">Attempts</th><th class="px-2 py-3 font-medium">Action</th></tr></thead>
            <tbody class="divide-y divide-border/70">
              {#each webhooks as record (record.id)}
                <tr class="align-top"><td class="px-2 py-3"><Badge variant="secondary">{record.provider === 'nowpayments' ? 'Crypto' : 'Stripe'}</Badge><div class="mt-1 text-xs text-muted">{record.rawBodyBytes} bytes</div></td><td class="px-2 py-3"><div class="max-w-64 truncate font-mono text-xs" title={record.eventId}>{record.eventId}</div><div class="mt-1 max-w-64 truncate font-mono text-[10px] text-muted" title={record.rawBodySha256}>{record.rawBodySha256}</div></td><td class="px-2 py-3"><Badge variant={statusVariant(record.status)}>{record.status}</Badge>{#if record.lastError}<div class="mt-1 flex max-w-64 items-start gap-1 text-xs text-err"><AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" />{record.lastError}</div>{/if}</td><td class="px-2 py-3 text-xs text-muted">{date(new Date(record.receivedAt).toISOString())}</td><td class="px-2 py-3 text-xs text-muted">{record.attempts}</td><td class="px-2 py-3"><div class="flex flex-wrap gap-2">{#if record.status !== 'processed' && record.status !== 'quarantined'}<Button size="sm" variant="secondary" loading={webhookAction === record.id} onclick={() => void replayWebhook(record)}><RotateCcw class="h-3.5 w-3.5" /> Replay</Button><Button size="sm" variant="ghost" loading={webhookAction === record.id} onclick={() => void quarantineWebhook(record)}><ShieldAlert class="h-3.5 w-3.5" /> Quarantine</Button>{/if}</div></td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if webhookNextCursor}<div class="mt-3 flex justify-center"><Button size="sm" variant="secondary" loading={webhookLoading} onclick={() => void loadWebhooks(webhookNextCursor)}>Load more ({Math.max(0, webhookTotal - webhooks.length)} older)</Button></div>{/if}
      {/if}
    </Card>
  {/if}
</div>
