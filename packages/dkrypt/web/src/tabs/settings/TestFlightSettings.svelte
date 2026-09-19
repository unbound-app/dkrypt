<script lang="ts">
  import { Check, LockKeyhole, RefreshCw, ShieldCheck, UserRound, X } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import {
    approveTestFlightSubscription,
    denyTestFlightSubscription,
    fetchDevices,
    fetchTestFlightCatalog,
    fetchTestFlightSubscriptions,
    syncTestFlightSubscription,
    unsubscribeTestFlightCatalogApp,
    unsubscribeTestFlightSubscription,
    type DeviceRecord,
    type TestFlightCatalogApp,
    type TestFlightSubscription,
    type TestFlightSubscriptionDeviceStatus,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  const canManage = $derived(sessionHasPermission(PermissionFlag.manageTestFlightSubscriptions));
  const canViewDevices = $derived(sessionHasAnyPermission([PermissionFlag.viewDevices, PermissionFlag.manageDevices]));
  let subscriptions = $state<TestFlightSubscription[]>([]);
  let deviceApps = $state<TestFlightCatalogApp[]>([]);
  let devices = $state<DeviceRecord[]>([]);
  let loading = $state(true);
  let busyId = $state<string | null>(null);
  let busyBundleId = $state<string | null>(null);

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
      deviceApps = canManage ? (await fetchTestFlightCatalog()).apps : [];
    } catch {
      subscriptions = [];
      deviceApps = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

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

  async function unsubscribeDeviceApp(app: TestFlightCatalogApp): Promise<void> {
    if (!(await confirmDialog(`Remove ${app.displayName} from the connected devices? TestFlight membership itself may remain active with Apple.`, { confirmLabel: 'Remove from devices', variant: 'destructive' }))) return;
    busyBundleId = app.bundleId;
    try {
      const result = await unsubscribeTestFlightCatalogApp(app.bundleId);
      if (result.ok) {
        showToast(result.data.failures.length > 0 ? 'Removed with device warnings' : 'Removed from connected devices', result.data.failures.length > 0 ? 'error' : 'success');
        await load();
      }
    } finally {
      busyBundleId = null;
    }
  }
</script>

<div class="flex flex-col gap-4">
  <Card title="TestFlight subscription management">
    <div class="mb-4 max-w-2xl text-sm text-muted">
      This page is for approvals and device synchronization. Actual TestFlight availability is read from the connected devices, so apps already present in TestFlight appear in the Home search automatically.
    </div>
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
                {#if canManage && subscription.bundleId !== 'com.hammerandchisel.discord' && subscription.status === 'pending'}
                  <Button size="sm" loading={busyId === subscription.id} onclick={() => void decide(subscription, 'approve')}><Check class="h-3.5 w-3.5" /> Approve</Button>
                  <Button size="sm" variant="destructive" disabled={busyId === subscription.id} onclick={() => void decide(subscription, 'deny')}><X class="h-3.5 w-3.5" /> Deny</Button>
                {/if}
                {#if canManage && subscription.bundleId !== 'com.hammerandchisel.discord' && subscription.status === 'approved'}
                  <Button size="sm" variant="secondary" loading={busyId === subscription.id} onclick={() => void sync(subscription)}><RefreshCw class="h-3.5 w-3.5" /> Sync</Button>
                {/if}
                {#if subscription.bundleId === 'com.hammerandchisel.discord'}
                  <Badge variant="secondary"><LockKeyhole class="h-3 w-3" /> Protected</Badge>
                {:else if subscription.status !== 'withdrawn' && subscription.status !== 'denied'}
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
    {#if canManage}
      <div class="border-border/70 mt-5 border-t pt-4">
        <div class="mb-3 flex items-center justify-between gap-2">
          <div>
            <div class="text-sm font-medium">Detected on connected devices</div>
            <div class="text-xs text-muted">This list is read directly from TestFlight on each enabled device.</div>
          </div>
          <Badge variant="secondary">Device source</Badge>
        </div>
        {#if deviceApps.length === 0}
          <div class="text-sm text-muted">No TestFlight apps were reported by the enabled devices.</div>
        {:else}
          <div class="divide-border/70 divide-y">
            {#each deviceApps as app (app.bundleId)}
              <div class="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between">
                <div class="flex min-w-0 items-center gap-3">
                  {#if app.iconUrl}
                    <img src={app.iconUrl} alt="" class="h-9 w-9 rounded-xl border border-border/70 object-cover" />
                  {:else}
                    <div class="bg-secondary text-muted flex h-9 w-9 items-center justify-center rounded-xl"><ShieldCheck class="h-4 w-4" /></div>
                  {/if}
                  <div class="min-w-0">
                    <div class="truncate text-sm font-medium">{app.displayName}</div>
                    <div class="truncate text-xs text-muted">{app.bundleId} · {app.devices.map((device) => device.name).join(', ')}</div>
                  </div>
                </div>
                {#if app.bundleId === 'com.hammerandchisel.discord'}
                  <Badge variant="secondary"><LockKeyhole class="h-3 w-3" /> Protected</Badge>
                {:else}
                  <Button size="sm" variant="ghost" loading={busyBundleId === app.bundleId} onclick={() => void unsubscribeDeviceApp(app)}>Remove from devices</Button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </Card>
</div>
