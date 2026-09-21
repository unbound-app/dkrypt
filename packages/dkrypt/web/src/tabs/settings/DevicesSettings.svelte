<script lang="ts">
  import { AlertTriangle, CheckCircle2, CircleX, Pencil, RefreshCw, Search, Smartphone, Star, Trash2, Usb, Wifi } from 'lucide-svelte';
  import DeviceArtwork from '#components/DeviceArtwork.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import {
    discoverDevices,
    fetchDeviceActivity,
    fetchDeviceHealth,
    fetchDeviceInventory,
    fetchDevicePreflight,
    fetchDevices,
    fetchSettings,
    recoverDevice,
    saveSettings,
    setDeviceDarkMode,
    setupDevice,
    updateDevice,
    deleteDevice,
    type DeviceDiscoveryCandidate,
    type DeviceDiscoveryResult,
    type DeviceHealth,
    type DeviceActivityEntry,
    type DeviceRecord,
    type DeviceSetupResult,
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
  import { getAppleDeviceModelName } from '#lib/deviceModel';
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
    void fetchSettings().then((settings) => (maintenanceSettings = settings));
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
  let activity = $state<Record<string, DeviceActivityEntry[]>>({});

  function loadHealth(): void {
    for (const device of devices) {
      void fetchDeviceHealth(device.id).then((value) => (health = { ...health, [device.id]: value })).catch(() => {});
      void fetchDeviceActivity(device.id, 6).then(({ activity: entries }) => (activity = { ...activity, [device.id]: entries })).catch(() => {});
    }
  }

  async function reloadDevices(): Promise<void> {
    try {
      const result = await fetchDevices();
      if (liveState.overview) liveState.overview = { ...liveState.overview, devices: result.devices };
    } catch {}
  }

  $effect(() => {
    devices;
    loadHealth();
    const interval = setInterval(loadHealth, 30_000);
    return () => clearInterval(interval);
  });

  let testingId = $state<Set<string>>(new Set());
  let inspectingId = $state<Set<string>>(new Set());
  let recoveringId = $state<Set<string>>(new Set());
  let updatingDarkModeId = $state<Set<string>>(new Set());
  let deletingId = $state<Set<string>>(new Set());
  let preflightOpen = $state(false);
  let preflight = $state<Awaited<ReturnType<typeof fetchDevicePreflight>> | null>(null);
  let inventoryOpen = $state(false);
  let inventory = $state<{ deviceId: string; bundles: string[] } | null>(null);

  async function testConnection(device: DeviceRecord): Promise<void> {
    testingId = new Set(testingId).add(device.id);
    try {
      const value = await fetchDeviceHealth(device.id, true);
      health = { ...health, [device.id]: value };
      showToast(value.reachable ? `${device.name} is reachable` : `${device.name} is unreachable${value.error ? `: ${value.error}` : ''}`, value.reachable ? 'success' : 'error');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Connection test failed', 'error');
    } finally {
      const next = new Set(testingId);
      next.delete(device.id);
      testingId = next;
    }
  }

  async function inspectDevice(device: DeviceRecord): Promise<void> {
    inspectingId = new Set(inspectingId).add(device.id);
    try {
      preflight = await fetchDevicePreflight(device.id);
      preflightOpen = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Preflight failed', 'error');
    } finally {
      const next = new Set(inspectingId);
      next.delete(device.id);
      inspectingId = next;
    }
  }

  async function inspectInventory(device: DeviceRecord): Promise<void> {
    inspectingId = new Set(inspectingId).add(device.id);
    try {
      inventory = await fetchDeviceInventory(device.id);
      inventoryOpen = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Inventory lookup failed', 'error');
    } finally {
      const next = new Set(inspectingId);
      next.delete(device.id);
      inspectingId = next;
    }
  }

  async function recover(device: DeviceRecord): Promise<void> {
    recoveringId = new Set(recoveringId).add(device.id);
    try {
      const result = await recoverDevice(device.id);
      if (result.ok) {
        if (result.data) health = { ...health, [device.id]: result.data };
        void fetchDeviceHealth(device.id, true).then((value) => (health = { ...health, [device.id]: value })).catch(() => {});
        showToast(`${device.name} recovery completed`, 'success');
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Device recovery failed', 'error');
    } finally {
      const next = new Set(recoveringId);
      next.delete(device.id);
      recoveringId = next;
    }
  }

  async function toggleDarkMode(device: DeviceRecord, enabled: boolean): Promise<void> {
    updatingDarkModeId = new Set(updatingDarkModeId).add(device.id);
    try {
      const result = await setDeviceDarkMode(device.id, enabled);
      if (result.ok) health = { ...health, [device.id]: result.data };
    } finally {
      const next = new Set(updatingDarkModeId);
      next.delete(device.id);
      updatingDarkModeId = next;
    }
  }

  let discoveryOpen = $state(false);
  let discoveryLoading = $state(false);
  let discovery = $state<DeviceDiscoveryResult | null>(null);
  let discoveryError = $state('');
  let setupExistingId = $state<string | undefined>();
  let setupCandidate = $state<DeviceDiscoveryCandidate | null>(null);
  let setupName = $state('');
  let manualHost = $state('');
  let manualPort = $state('22');
  let manualUser = $state('mobile');

  let setupOpen = $state(false);
  let setupRunning = $state(false);
  let setupError = $state('');
  let setupResult = $state<DeviceSetupResult | null>(null);

  async function openDiscovery(existingId?: string): Promise<void> {
    setupExistingId = existingId;
    discoveryOpen = true;
    discoveryLoading = true;
    discoveryError = '';
    try {
      discovery = await discoverDevices();
    } catch (error) {
      discoveryError = error instanceof Error ? error.message : 'Device discovery failed';
    } finally {
      discoveryLoading = false;
    }
  }

  function prepareSetup(candidate: DeviceDiscoveryCandidate): void {
    discoveryOpen = false;
    setupCandidate = candidate;
    setupName = candidate.name;
    setupError = '';
    setupResult = null;
    setupOpen = true;
    void runSetup(candidate);
  }

  function prepareManualSetup(): void {
    const host = manualHost.trim();
    const port = Number.parseInt(manualPort, 10);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) {
      showToast('Enter a valid Wi-Fi address and port', 'error');
      return;
    }
    prepareSetup({ discoveryId: `manual-${host}`, name: host, transport: 'wifi', host, port, user: manualUser.trim() || 'mobile', source: 'wifi' });
  }

  async function runSetup(candidate: DeviceDiscoveryCandidate): Promise<void> {
    setupRunning = true;
    try {
      const result = await setupDevice(candidate, { name: setupName.trim() || candidate.name, existingId: setupExistingId });
      if (result.ok) {
        setupResult = result.data.setup;
        await reloadDevices();
      } else {
        const message = (result.data as { error?: unknown }).error;
        setupError = typeof message === 'string' ? message : 'Device setup could not be completed. Try again.';
      }
    } catch (error) {
      setupError = error instanceof Error ? error.message : 'Device setup failed';
    } finally {
      setupRunning = false;
    }
  }

  function retrySetup(): void {
    if (!setupCandidate) return;
    setupError = '';
    setupResult = null;
    void runSetup(setupCandidate);
  }

  let editOpen = $state(false);
  let editingId = $state<string | null>(null);
  let formName = $state('');
  let formIosVersion = $state('');
  let formToolchain = $state('');
  let formNotes = $state('');
  let saving = $state(false);

  function openEdit(device: DeviceRecord): void {
    editingId = device.id;
    formName = device.name;
    formIosVersion = device.iosVersion ?? '';
    formToolchain = device.toolchain ?? '';
    formNotes = device.notes ?? '';
    editOpen = true;
  }

  async function save(): Promise<void> {
    if (!editingId || !formName.trim()) {
      showToast('A device name is required', 'error');
      return;
    }
    saving = true;
    try {
      const result = await updateDevice(editingId, { name: formName.trim(), iosVersion: formIosVersion.trim(), toolchain: formToolchain.trim(), notes: formNotes.trim() });
      if (result.ok) {
        editOpen = false;
        await reloadDevices();
      }
    } finally {
      saving = false;
    }
  }

  async function remove(device: DeviceRecord): Promise<void> {
    if (!(await confirmDialog(`Remove "${device.name}"? Any of its running/queued jobs will fail.`))) return;
    deletingId = new Set(deletingId).add(device.id);
    try {
      await deleteDevice(device.id);
      await reloadDevices();
    } finally {
      const next = new Set(deletingId);
      next.delete(device.id);
      deletingId = next;
    }
  }

  async function toggleEnabled(device: DeviceRecord): Promise<void> {
    await updateDevice(device.id, { enabled: !device.enabled });
    await reloadDevices();
  }

  async function makePrimary(device: DeviceRecord): Promise<void> {
    await updateDevice(device.id, { isPrimary: true });
    await reloadDevices();
  }

  function connectionLabel(device: DeviceRecord): string {
    if (device.udid) return `${device.transport === 'usb' ? 'USB' : 'Wi-Fi pairing'} · ${device.udid}`;
    if (device.host) return `${device.user}@${device.host}:${device.port}`;
    return 'Legacy connection · finish setup to migrate';
  }
</script>

{#if canViewMaintenance}
  <Card title="Maintenance mode" class="mb-4">
    <div class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <div class="text-sm">Pause decrypts &amp; API</div>
        <div class="text-xs text-muted">Blocks every decrypt request and API call. Also engages on its own when the primary device isn't in a usable state.</div>
      </div>
      <Switch checked={maintenanceSettings?.maintenanceMode ?? false} disabled={!canManageMaintenance || !maintenanceSettings || togglingMaintenance} onCheckedChange={() => void toggleMaintenance()} aria-label="Maintenance mode" />
    </div>
    {#if maintenanceStatus?.auto && !maintenanceSettings?.maintenanceMode}<div class="text-warn mt-2 text-xs">Auto-engaged: {maintenanceStatus.reason}.</div>{/if}
  </Card>
{/if}

<Card title="Devices">
  {#snippet headerExtra()}
    {#if canManageDevices}<Button size="sm" onclick={() => void openDiscovery()}><Search class="h-3.5 w-3.5" />Find a device</Button>{/if}
  {/snippet}
  <div class="mb-4 max-w-3xl text-sm text-muted">Connect a jailbroken iPhone or iPad over USB or Wi-Fi. dkrypt discovers it, verifies the connection, checks every prerequisite, and adds it to the pool with a clear readiness summary.</div>
  {#if devices.length === 0}
    <EmptyState icon={Smartphone} message="No devices connected yet." />
  {:else}
    <div class="grid gap-3 xl:grid-cols-2">
      {#each devices as device (device.id)}
        {@const h = health[device.id]}
        {@const model = getAppleDeviceModelName(device.productType, device.name)}
        <div class="border-border/80 bg-background/30 min-w-0 rounded-xl border p-4">
          <div class="flex items-start gap-3">
            <DeviceArtwork productType={device.productType} name={device.name} />
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5"><span class="truncate text-sm font-semibold">{device.name}</span>{#if device.isPrimary}<Badge variant="default"><Star class="mr-1 h-3 w-3" />primary</Badge>{/if}<Badge variant="secondary">{device.transport === 'usb' ? 'USB' : 'Wi-Fi'}</Badge>{#if h}<Badge variant={h.reachable ? 'success' : 'destructive'}>{h.reachable ? 'online' : 'offline'}</Badge>{/if}{#if h?.readiness}<Badge variant={h.readiness.state === 'ready' ? 'success' : h.readiness.state === 'caution' ? 'secondary' : 'destructive'}>{h.readiness.score}/100 ready</Badge>{/if}</div>
              <div class="mt-1 text-xs font-medium text-foreground/80">{model ?? 'Apple device'}{device.productType && model !== device.productType ? ` · ${device.productType}` : ''}</div>
              <div class="mt-1 truncate font-mono text-[11px] text-muted" title={connectionLabel(device)}>{connectionLabel(device)}</div>
            </div>
            {#if canManageDevices}<Button size="icon" variant="ghost" class="h-8 w-8 shrink-0" onclick={() => openEdit(device)} aria-label={`Edit ${device.name}`} title="Edit device"><Pencil class="h-3.5 w-3.5" /></Button>{/if}
          </div>
          <div class="mt-3 grid grid-cols-2 gap-2 text-xs"><div class="bg-muted/30 rounded-lg px-2.5 py-2"><div class="text-muted">iOS</div><div class="mt-0.5 truncate font-medium">{device.iosVersion ?? 'Not reported'}</div></div><div class="bg-muted/30 rounded-lg px-2.5 py-2"><div class="text-muted">Bridge</div><div class="mt-0.5 truncate font-medium">{h?.bridgeHeartbeats?.springboard?.bridgeVersion ?? 'Not checked'}</div></div></div>
          {#if device.legacyConnection && canManageDevices}<div class="border-warn/40 bg-warn/10 text-warn mt-3 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs"><AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>This device still uses the old connection file. Find it again to migrate it to direct USB/Wi-Fi setup.</span><Button size="sm" variant="secondary" class="ml-auto shrink-0" onclick={() => void openDiscovery(device.id)}>Finish setup</Button></div>{/if}
          {#if h?.readiness?.reasons.length}<div class="text-warn mt-2 text-xs">{h.readiness.reasons.join(' · ')}</div>{/if}
          <div class="border-border/70 mt-3 flex flex-wrap items-center gap-1.5 border-t pt-3"><Button size="sm" variant="secondary" loading={testingId.has(device.id)} onclick={() => void testConnection(device)}>Test connection</Button><Button size="sm" variant="secondary" loading={inspectingId.has(device.id)} onclick={() => void inspectDevice(device)}>Preflight</Button><Button size="sm" variant="secondary" loading={inspectingId.has(device.id)} onclick={() => void inspectInventory(device)}>Inventory</Button>{#if canManageDevices}<Button size="sm" variant="secondary" loading={recoveringId.has(device.id)} onclick={() => void recover(device)}>Recover</Button>{#if !device.isPrimary}<Button size="sm" variant="ghost" onclick={() => void makePrimary(device)}>Make primary</Button>{/if}<Button size="sm" variant="ghost" onclick={() => void toggleEnabled(device)}>{device.enabled ? 'Disable' : 'Enable'}</Button><Button size="icon" variant="ghost" class="ml-auto h-8 w-8 text-muted hover:text-err" loading={deletingId.has(device.id)} onclick={() => void remove(device)} aria-label={`Remove ${device.name}`} title="Remove device"><Trash2 class="h-3.5 w-3.5" /></Button>{/if}</div>
          {#if device.isPrimary && h?.reachable && h.darkEnabled !== undefined}<div class="border-border/70 mt-3 flex items-center justify-between gap-3 border-t pt-3"><div class="min-w-0"><div class="text-sm">Keep display dark</div><div class="text-xs text-muted">autoinstall keeps the device awake while the display is blacked out.</div></div><Switch checked={h.darkEnabled} disabled={!canManageDevices || updatingDarkModeId.has(device.id)} onCheckedChange={(enabled) => void toggleDarkMode(device, enabled)} aria-label="Keep display dark" /></div>{/if}
          {#if activity[device.id]?.length}<div class="border-border/70 mt-3 border-t pt-3"><div class="mb-1.5 text-xs text-muted">Recent activity</div><div class="flex flex-col gap-1.5">{#each activity[device.id] as entry (entry.id)}<div class="flex items-start gap-2 text-xs"><span class="shrink-0 text-muted"><RelativeTime ms={entry.ts} /></span><span>{entry.message}{entry.bundleId ? ` · ${entry.bundleId}` : ''}</span></div>{/each}</div></div>{/if}
        </div>
      {/each}
    </div>
  {/if}
</Card>

{#if canManageDevices}
  <Dialog open={discoveryOpen} onOpenChange={(value) => (discoveryOpen = value)} class="max-w-2xl">
    <div class="mb-1 flex items-center justify-between gap-3"><div class="text-sm font-semibold">Find a device</div><Button size="icon" variant="ghost" class="h-8 w-8" loading={discoveryLoading} onclick={() => void openDiscovery(setupExistingId)} aria-label="Scan again" title="Scan again"><RefreshCw class="h-3.5 w-3.5" /></Button></div>
    <div class="mb-4 text-xs text-muted">USB devices and paired Wi-Fi devices appear automatically. dkrypt also checks reachable iOS SSH services on the local network.</div>
    {#if discoveryError}<div class="border-err/40 bg-err/10 text-err mb-3 rounded-lg border px-3 py-2 text-sm">{discoveryError}</div>{/if}
    {#if discovery?.warnings.length}<div class="border-warn/40 bg-warn/10 text-warn mb-3 rounded-lg border px-3 py-2 text-xs">{discovery.warnings.join(' · ')}</div>{/if}
    {#if discoveryLoading}<div class="flex items-center justify-center gap-2 py-10 text-sm text-muted"><RefreshCw class="h-4 w-4 animate-spin" />Scanning for USB and Wi-Fi devices…</div>{:else if discovery?.devices.length}<div class="flex max-h-80 flex-col gap-2 overflow-auto">{#each discovery.devices as candidate (candidate.discoveryId)}<div class="border-border flex items-center gap-3 rounded-lg border p-3"><div class="bg-muted/40 flex h-8 w-8 shrink-0 items-center justify-center rounded-md">{#if candidate.transport === 'usb'}<Usb class="h-4 w-4" />{:else}<Wifi class="h-4 w-4" />{/if}</div><div class="min-w-0 flex-1"><div class="truncate text-sm font-medium">{candidate.name}</div><div class="truncate font-mono text-[11px] text-muted">{candidate.host ? `${candidate.user}@${candidate.host}:${candidate.port}` : candidate.udid}</div>{#if candidate.productType || candidate.productVersion}<div class="mt-0.5 text-[11px] text-muted">{candidate.productType ?? 'iDevice'}{candidate.productVersion ? ` · iOS ${candidate.productVersion}` : ''}</div>{/if}</div><Badge variant="secondary">{candidate.transport === 'usb' ? 'USB' : 'Wi-Fi'}</Badge><Button size="sm" onclick={() => prepareSetup(candidate)}>Set up</Button></div>{/each}</div>{:else}<EmptyState icon={Search} message="No iOS devices found on the connected networks." />{/if}
    <div class="border-border/70 mt-4 border-t pt-4"><div class="mb-2 text-xs font-medium">Have the address already?</div><div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]"><Input placeholder="192.168.2.158" bind:value={manualHost} aria-label="Wi-Fi device address" /><Input class="w-20" placeholder="22" bind:value={manualPort} aria-label="SSH port" /><Button variant="secondary" onclick={prepareManualSetup}>Use address</Button></div><div class="mt-1.5 text-[11px] text-muted">The dashboard uses the configured host SSH key and defaults to the mobile user.</div></div>
  </Dialog>

  <Dialog open={setupOpen} onOpenChange={(value) => (setupOpen = value)} class="max-w-xl">
    <div class="mb-1 text-sm font-semibold">Set up {setupName || 'device'}</div><div class="mb-4 text-xs text-muted">dkrypt is connecting, identifying the device, and checking the automation prerequisites.</div>
    {#if setupError}<div class="border-err/40 bg-err/10 text-err mb-3 rounded-lg border px-3 py-2 text-sm">{setupError}</div>{/if}
    {#if setupRunning}<div class="flex items-center justify-center gap-2 py-8 text-sm text-muted"><RefreshCw class="h-4 w-4 animate-spin" />Running device setup…</div>{/if}
    {#if setupResult}<div class="mb-3 flex items-center gap-2 text-sm font-medium">{#if setupResult.ready}<CheckCircle2 class="text-ok h-4 w-4" />Device is ready for decrypts{:else}<AlertTriangle class="text-warn h-4 w-4" />Device connected with attention needed{/if}</div><div class="flex flex-col gap-2">{#each setupResult.steps as step (step.id)}<div class="border-border flex items-start gap-3 rounded-lg border p-3"><div class="mt-0.5">{#if step.status === 'ready'}<CheckCircle2 class="text-ok h-4 w-4" />{:else if step.status === 'attention'}<AlertTriangle class="text-warn h-4 w-4" />{:else}<CircleX class="text-err h-4 w-4" />{/if}</div><div class="min-w-0 flex-1"><div class="text-sm">{step.label}</div>{#if step.detail}<div class="mt-0.5 text-xs text-muted">{step.detail}</div>{/if}</div><Badge variant={step.status === 'ready' ? 'success' : step.status === 'attention' ? 'secondary' : 'destructive'}>{step.status === 'ready' ? 'ready' : step.status}</Badge></div>{/each}</div>{#if !setupResult.ready}<div class="border-warn/40 bg-warn/10 text-warn mt-3 rounded-lg border px-3 py-2 text-xs">The device is saved so you can fix the listed prerequisite and run setup again. No connection directory or CLI command is required.</div>{/if}<Button class="mt-4 w-full" onclick={() => (setupOpen = false)}>Done</Button>{:else if !setupRunning}<div class="mt-4 flex gap-2"><Button variant="secondary" class="flex-1" onclick={() => (setupOpen = false)}>Close</Button><Button class="flex-1" onclick={retrySetup}>Try again</Button></div>{/if}
  </Dialog>

  <Dialog open={editOpen} onOpenChange={(value) => (editOpen = value)} class="max-w-md">
    <div class="mb-3 text-sm font-semibold">Edit device</div><label for="d-name" class="mb-1 block text-xs text-muted">Name</label><Input id="d-name" placeholder="e.g. iPad Pro" bind:value={formName} /><label for="d-ios" class="mt-3 mb-1 block text-xs text-muted">iOS version</label><Input id="d-ios" placeholder="Detected automatically during setup" bind:value={formIosVersion} /><label for="d-toolchain" class="mt-3 mb-1 block text-xs text-muted">Jailbreak</label><Input id="d-toolchain" placeholder="e.g. Dopamine" bind:value={formToolchain} /><label for="d-notes" class="mt-3 mb-1 block text-xs text-muted">Notes</label><Input id="d-notes" placeholder="Optional compatibility notes" bind:value={formNotes} /><Button class="mt-4 w-full" loading={saving} onclick={() => void save()}>Save changes</Button>
  </Dialog>
{/if}

<Dialog open={preflightOpen} onOpenChange={(value) => (preflightOpen = value)} class="max-w-lg">
  <div class="mb-1 text-sm font-medium">Device preflight</div>{#if preflight}<div class="mb-3 text-xs text-muted">{preflight.device.name} · {preflight.ready ? 'ready for automation' : 'needs attention'}</div><div class="flex flex-col gap-2">{#each preflight.checks as check (check.label)}<div class="border-border flex items-start justify-between gap-3 rounded-lg border p-2.5 text-sm"><div><div>{check.label}</div>{#if check.detail}<div class="mt-0.5 text-xs text-muted">{check.detail}</div>{/if}</div><Badge variant={check.ok ? 'success' : 'destructive'}>{check.ok ? 'ready' : 'attention'}</Badge></div>{/each}</div>{#if preflight.bridge?.bridge.bridgeVersion}<div class="mt-3 text-xs text-muted">autoinstall {preflight.bridge.bridge.bridgeVersion} · {(preflight.bridge.bridge.capabilities ?? []).join(', ') || 'no capabilities reported'}</div>{/if}{/if}
</Dialog>

<Dialog open={inventoryOpen} onOpenChange={(value) => (inventoryOpen = value)} class="max-w-lg">
  <div class="mb-1 text-sm font-medium">Installed App Store inventory</div><div class="mb-3 text-xs text-muted">Encrypted App Store bundles currently present on the device.</div>{#if inventory?.bundles.length}<div class="max-h-96 overflow-auto rounded-lg border border-border">{#each inventory.bundles as bundle (bundle)}<div class="border-border border-b px-3 py-2 font-mono text-xs last:border-b-0">{bundle}</div>{/each}</div>{:else}<div class="text-sm text-muted">No encrypted App Store bundles found.</div>{/if}
</Dialog>
