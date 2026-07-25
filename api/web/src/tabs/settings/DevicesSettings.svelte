<script lang="ts">
  import { Plus } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import {
    createDevice,
    deleteDevice,
    fetchDeviceHealth,
    fetchSettings,
    saveSettings,
    updateDevice,
    type DeviceHealth,
    type DeviceRecord,
    type SchedulerSettings,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Switch from '#lib/components/ui/Switch.svelte';
  import { liveState } from '#lib/live.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { confirmDialog, showToast } from '#lib/ui.svelte';

  const canManageDevices = $derived(sessionHasPermission(PermissionFlag.manageDevices));
  const canViewMaintenance = $derived(sessionHasAnyPermission([PermissionFlag.viewAutomation, PermissionFlag.manageAutomation]));
  const canManageMaintenance = $derived(sessionHasPermission(PermissionFlag.manageAutomation));
  const devices = $derived(liveState.overview?.devices ?? []);
  const maintenanceStatus = $derived(liveState.overview?.maintenance);

  let maintenanceSettings = $state<SchedulerSettings | null>(null);
  let togglingMaintenance = $state(false);

  $effect(() => {
    if (!canViewMaintenance) return;
    void fetchSettings().then((s) => (maintenanceSettings = s));
  });

  async function toggleMaintenance(): Promise<void> {
    if (!maintenanceSettings) return;
    const enabling = !maintenanceSettings.maintenanceMode;
    const confirmed = await confirmDialog(
      enabling
        ? 'Pause every decrypt request and API call right now? Anyone using the API will get blocked until this is turned off again.'
        : "Resume decrypts and the API? If maintenance mode was auto-engaged, make sure the underlying device issue is actually resolved first - it'll just re-engage on its own if not.",
      { variant: enabling ? 'destructive' : 'default', confirmLabel: enabling ? 'Pause everything' : 'Resume' },
    );
    if (!confirmed) return;
    togglingMaintenance = true;
    try {
      const { ok, data } = await saveSettings({ ...maintenanceSettings, maintenanceMode: enabling });
      if (ok) maintenanceSettings = data;
    } finally {
      togglingMaintenance = false;
    }
  }

  let health = $state<Record<string, DeviceHealth | undefined>>({});

  function loadHealth(): void {
    for (const d of devices) {
      void fetchDeviceHealth(d.id).then((h) => (health = { ...health, [d.id]: h }));
    }
  }

  $effect(() => {
    devices;
    loadHealth();
    const interval = setInterval(loadHealth, 30_000);
    return () => clearInterval(interval);
  });

  let dialogOpen = $state(false);
  let editingId = $state<string | null>(null);
  let formName = $state('');
  let formRootDir = $state('');
  let saving = $state(false);
  let deletingId = $state<Set<string>>(new Set());

  function openAdd(): void {
    editingId = null;
    formName = '';
    formRootDir = '';
    dialogOpen = true;
  }

  function openEdit(d: DeviceRecord): void {
    editingId = d.id;
    formName = d.name;
    formRootDir = d.rootDir;
    dialogOpen = true;
  }

  async function save(): Promise<void> {
    if (!formName.trim() || !formRootDir.trim()) {
      showToast('Name and root dir are required', 'error');
      return;
    }
    saving = true;
    try {
      const { ok } = editingId
        ? await updateDevice(editingId, { name: formName.trim(), rootDir: formRootDir.trim() })
        : await createDevice(formName.trim(), formRootDir.trim());
      if (ok) dialogOpen = false;
    } finally {
      saving = false;
    }
  }

  async function remove(id: string): Promise<void> {
    if (!(await confirmDialog('Remove this device? Any of its running/queued jobs will fail.'))) return;
    deletingId = new Set(deletingId).add(id);
    try {
      await deleteDevice(id);
    } finally {
      const next = new Set(deletingId);
      next.delete(id);
      deletingId = next;
    }
  }

  async function toggleEnabled(d: DeviceRecord): Promise<void> {
    await updateDevice(d.id, { enabled: !d.enabled });
  }

  async function makePrimary(d: DeviceRecord): Promise<void> {
    await updateDevice(d.id, { isPrimary: true });
  }
</script>

{#if canViewMaintenance}
  <Card title="Maintenance mode" class="mb-4">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm">Pause decrypts &amp; API</div>
        <div class="text-xs text-muted">Blocks every decrypt request and API call. Also engages on its own when the primary device isn't in a usable state.</div>
      </div>
      <Switch
        checked={maintenanceSettings?.maintenanceMode ?? false}
        disabled={!canManageMaintenance || !maintenanceSettings || togglingMaintenance}
        onCheckedChange={() => void toggleMaintenance()}
        aria-label="Maintenance mode"
      />
    </div>
    {#if maintenanceStatus?.auto && !maintenanceSettings?.maintenanceMode}
      <div class="text-warn mt-2 text-xs">Auto-engaged: {maintenanceStatus.reason}.</div>
    {/if}
  </Card>
{/if}

<Card title="Device pool">
  {#snippet headerExtra()}
    {#if canManageDevices}
      <Button size="sm" onclick={openAdd}>
        <Plus class="h-3.5 w-3.5" />
        Add device
      </Button>
    {/if}
  {/snippet}
  <div class="mb-3 text-sm text-muted">
    Each device needs to already be bootstrapped independently (<code>ipadecrypt --root-dir &lt;path&gt; bootstrap</code>) before
    it's registered here. TestFlight jobs always run on the primary device - only App Store decrypts distribute across the
    whole pool.
  </div>
  {#if devices.length === 0}
    <EmptyState message="No devices registered." />
  {:else}
    <div class="flex flex-col gap-2.5">
      {#each devices as d (d.id)}
        {@const h = health[d.id]}
        <div class="border-border rounded-lg border p-3">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-[13px] font-medium">{d.name}</span>
            {#if d.isPrimary}
              <Badge variant="default">primary</Badge>
            {/if}
            {#if h}
              <Badge variant={h.reachable ? 'success' : 'destructive'}>{h.reachable ? 'online' : 'unreachable'}</Badge>
            {/if}
            <div class="ml-auto flex flex-wrap gap-1.5">
              {#if canManageDevices}
                {#if !d.isPrimary}
                  <Button size="sm" variant="secondary" onclick={() => void makePrimary(d)}>Make primary</Button>
                {/if}
                <Button size="sm" variant="secondary" onclick={() => void toggleEnabled(d)}>{d.enabled ? 'Disable' : 'Enable'}</Button>
                <Button size="sm" variant="secondary" onclick={() => openEdit(d)}>Edit</Button>
                <Button size="sm" variant="destructive" loading={deletingId.has(d.id)} onclick={() => remove(d.id)}>Remove</Button>
              {/if}
            </div>
          </div>
          <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted">
            <span title={d.rootDir}>{d.rootDir}</span>
            {#if h?.checkedAt}
              <span class="font-sans">checked <RelativeTime ms={h.checkedAt} /></span>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</Card>

{#if canManageDevices}
  <Dialog open={dialogOpen} onOpenChange={(v) => (dialogOpen = v)} class="max-w-md">
    <div class="mb-3 text-sm font-medium">{editingId ? 'Edit device' : 'Add device'}</div>
    <label for="d-name" class="mb-1 block text-xs text-muted">Name</label>
    <Input id="d-name" placeholder="e.g. device-b" bind:value={formName} />
    <label for="d-rootDir" class="mt-3 mb-1 block text-xs text-muted">ipadecrypt root dir</label>
    <Input id="d-rootDir" placeholder="/data/devices/device-b" bind:value={formRootDir} />
    <div class="mt-1 text-xs text-muted">
      Must already contain a valid config.json from a prior <code>ipadecrypt --root-dir &lt;path&gt; bootstrap</code> run.
    </div>
    <Button class="mt-3.5 w-full" loading={saving} onclick={save}>{editingId ? 'Save' : 'Add'}</Button>
  </Dialog>
{/if}
