<script lang="ts">
  import { Check, Link2, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import {
    approveTestFlightSubscription,
    denyTestFlightSubscription,
    fetchDevices,
    fetchTestFlightSubscriptions,
    syncTestFlightSubscription,
    submitTestFlightSubscription,
    unsubscribeTestFlightSubscription,
    type DeviceRecord,
    type TestFlightSubscription,
    type TestFlightSubscriptionDeviceStatus,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageTestFlightSubscriptions));
  const canViewDevices = $derived(sessionHasAnyPermission([PermissionFlag.viewDevices, PermissionFlag.manageDevices]));
  let subscriptions = $state<TestFlightSubscription[]>([]);
  let devices = $state<DeviceRecord[]>([]);
  let inviteUrl = $state('');
  let loading = $state(true);
  let submitting = $state(false);
  let busyId = $state<string | null>(null);

  const deviceNames = $derived(new Map(devices.map((device) => [device.id, device.name])));

  function statusLabel(status: TestFlightSubscriptionDeviceStatus | TestFlightSubscription['status']): string {
    return status === 'active' ? 'Verified' : status === 'syncing' ? 'Syncing' : status === 'unavailable' ? 'Unavailable' : status === 'unsupported' ? 'Unsupported' : status === 'error' ? 'Error' : status === 'approved' ? 'Approved' : status === 'denied' ? 'Denied' : status === 'withdrawn' ? 'Withdrawn' : 'Pending';
  }

  function statusVariant(status: TestFlightSubscriptionDeviceStatus | TestFlightSubscription['status']): 'success' | 'warning' | 'destructive' | 'secondary' | 'default' {
    if (status === 'active' || status === 'approved') return 'success';
    if (status === 'syncing' || status === 'pending') return 'default';
    if (status === 'unavailable' || status === 'unsupported') return 'warning';
    if (status === 'error' || status === 'denied') return 'destructive';
    return 'secondary';
  }

  async function load(): Promise<void> {
    loading = true;
    try {
      const [subscriptionData, deviceData] = await Promise.all([
        fetchTestFlightSubscriptions(),
        canViewDevices ? fetchDevices() : Promise.resolve({ devices: [] as DeviceRecord[] }),
      ]);
      subscriptions = subscriptionData.subscriptions;
      devices = deviceData.devices;
    } catch {
      subscriptions = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  async function submit(): Promise<void> {
    if (!inviteUrl.trim()) return;
    submitting = true;
    try {
      const result = await submitTestFlightSubscription(inviteUrl.trim());
      if (!result.ok) return;
      inviteUrl = '';
      showToast(canManage ? 'TestFlight access is being synchronized' : 'TestFlight request submitted for approval', 'success');
      await load();
    } finally {
      submitting = false;
    }
  }

  async function decide(subscription: TestFlightSubscription, action: 'approve' | 'deny'): Promise<void> {
    busyId = subscription.id;
    try {
      const result = action === 'approve' ? await approveTestFlightSubscription(subscription.id) : await denyTestFlightSubscription(subscription.id);
      if (result.ok) await load();
    } finally {
      busyId = null;
    }
  }

  async function sync(subscription: TestFlightSubscription): Promise<void> {
    busyId = subscription.id;
    try {
      const result = await syncTestFlightSubscription(subscription.id);
      if (result.ok) {
        showToast('Device verification started', 'success');
        await load();
      }
    } finally {
      busyId = null;
    }
  }

  async function unsubscribe(subscription: TestFlightSubscription): Promise<void> {
    if (!(await confirmDialog(`Stop dkrypt automation for ${subscription.displayName ?? subscription.url}? The app will be removed from enabled devices where possible.`, { confirmLabel: 'Unsubscribe', variant: 'destructive' }))) return;
    busyId = subscription.id;
    try {
      const result = await unsubscribeTestFlightSubscription(subscription.id);
      if (result.ok) {
        showToast('TestFlight subscription removed', 'success');
        await load();
      }
    } finally {
      busyId = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="Public TestFlight access">
    <div class="mb-4 max-w-2xl text-sm text-muted">
      Add a public TestFlight invite link to make its builds available in the decrypt search. Managers activate links immediately; other requests stay private until approved.
    </div>
    <form class="flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div class="relative min-w-0 flex-1">
        <Link2 class="text-muted pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
        <Input bind:value={inviteUrl} class="pl-9" placeholder="https://testflight.apple.com/join/ABC123" aria-label="TestFlight public link" />
      </div>
      <Button type="submit" loading={submitting} disabled={!inviteUrl.trim()}>Add public link</Button>
    </form>
  </Card>

  <Card title={canManage ? 'Subscription requests and access' : 'Your TestFlight access'}>
    {#if loading}
      <div class="text-sm text-muted">Loading TestFlight access…</div>
    {:else if subscriptions.length === 0}
      <div class="text-sm text-muted">No TestFlight subscriptions yet.</div>
    {:else}
      <div class="divide-border/70 divide-y">
        {#each subscriptions as subscription (subscription.id)}
          <div class="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="flex min-w-0 items-start gap-3">
                {#if subscription.iconUrl}
                  <img src={subscription.iconUrl} alt="" class="h-10 w-10 rounded-xl border border-border/70 object-cover" />
                {:else}
                  <div class="bg-secondary text-muted flex h-10 w-10 items-center justify-center rounded-xl"><ShieldCheck class="h-5 w-5" /></div>
                {/if}
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="truncate text-sm font-medium">{subscription.displayName ?? subscription.url}</span>
                    <Badge variant={statusVariant(subscription.status)}>{statusLabel(subscription.status)}</Badge>
                  </div>
                  <div class="mt-0.5 truncate text-xs text-muted">{subscription.bundleId ?? 'Resolving app metadata'} · {subscription.url}</div>
                  {#if canManage}
                    <div class="mt-1 flex items-center gap-1 text-[11px] text-muted"><UserRound class="h-3 w-3" /> {subscription.requestedBy}</div>
                  {/if}
                </div>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                {#if canManage && subscription.status === 'pending'}
                  <Button size="sm" loading={busyId === subscription.id} onclick={() => void decide(subscription, 'approve')}><Check class="h-3.5 w-3.5" /> Approve</Button>
                  <Button size="sm" variant="destructive" disabled={busyId === subscription.id} onclick={() => void decide(subscription, 'deny')}><X class="h-3.5 w-3.5" /> Deny</Button>
                {/if}
                {#if canManage && subscription.status === 'approved'}
                  <Button size="sm" variant="secondary" loading={busyId === subscription.id} onclick={() => void sync(subscription)}><RefreshCw class="h-3.5 w-3.5" /> Sync</Button>
                {/if}
                {#if subscription.status !== 'withdrawn' && subscription.status !== 'denied'}
                  <Button size="sm" variant="ghost" disabled={busyId === subscription.id} onclick={() => void unsubscribe(subscription)}>Unsubscribe</Button>
                {/if}
              </div>
            </div>
            {#if subscription.devices.length > 0}
              <div class="flex flex-wrap gap-2">
                {#each subscription.devices as device (device.deviceId)}
                  <div class="bg-secondary/50 flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs">
                    <span class="text-foreground">{deviceNames.get(device.deviceId) ?? device.deviceId}</span>
                    <Badge variant={statusVariant(device.status)}>{statusLabel(device.status)}</Badge>
                  </div>
                {/each}
              </div>
            {/if}
            {#if subscription.devices.some((device) => device.lastError)}
              <div class="text-xs text-warn">{subscription.devices.find((device) => device.lastError)?.lastError}</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </Card>
</div>
