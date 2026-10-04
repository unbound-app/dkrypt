<script lang="ts">
  import type { DeviceHealth, DeviceRecord } from '#lib/api';
  import { fmtBytesGB } from '#lib/format.svelte';

  let { devices, health }: { devices: DeviceRecord[]; health: Record<string, DeviceHealth | undefined> } = $props();
  let firstId = $state('');
  let secondId = $state('');

  $effect(() => {
    if (!devices.some((device) => device.id === firstId)) firstId = devices[0]?.id ?? '';
    if (!devices.some((device) => device.id === secondId) || secondId === firstId) secondId = devices.find((device) => device.id !== firstId)?.id ?? '';
  });

  const first = $derived(devices.find((device) => device.id === firstId));
  const second = $derived(devices.find((device) => device.id === secondId));
  const firstHealth = $derived(first ? health[first.id] : undefined);
  const secondHealth = $derived(second ? health[second.id] : undefined);

  function value(device: DeviceRecord | undefined, state: DeviceHealth | undefined, field: string): string {
    if (!device) return 'Not selected';
    if (field === 'Model') return device.productType ?? 'Not reported';
    if (field === 'iOS') return device.iosVersion ?? 'Not reported';
    if (field === 'Connection') return device.transport === 'usb' ? 'USB' : 'Wi-Fi';
    if (field === 'Availability') return state ? state.reachable ? 'Reachable' : 'Unavailable' : 'Not checked';
    if (field === 'Readiness') return state?.readiness ? `${state.readiness.score}/100 · ${state.readiness.state}` : 'Not checked';
    if (field === 'Battery') return state?.batteryPercent === undefined ? 'Not checked' : `${state.batteryPercent}%`;
    if (field === 'Free storage') return state?.storageFreeBytes === undefined ? 'Not checked' : fmtBytesGB(state.storageFreeBytes);
    return 'Not checked';
  }

  const fields = ['Model', 'iOS', 'Connection', 'Availability', 'Readiness', 'Battery', 'Free storage'];
</script>

<section class="mb-4 min-w-0 rounded-lg border border-border/70 bg-panel/40 p-3" aria-label="Device comparison">
  <h3 class="text-sm font-semibold">Device comparison</h3>
  <p class="mt-1 text-xs text-muted">Compare two saved devices using their latest checks. Missing readings are shown as not checked.</p>
  <div class="mt-3 grid min-w-0 grid-cols-[minmax(5rem,6rem)_repeat(2,minmax(0,1fr))] gap-x-2 gap-y-1 text-xs sm:grid-cols-[minmax(7rem,9rem)_repeat(2,minmax(0,1fr))]">
    <div></div>
    <label class="min-w-0" for="compare-first-device"><span class="sr-only">First device</span><select id="compare-first-device" class="min-h-9 w-full min-w-0 rounded-md border border-border bg-background px-1 text-xs" bind:value={firstId}>{#each devices as device (device.id)}<option value={device.id} disabled={device.id === secondId}>{device.name}</option>{/each}</select></label>
    <label class="min-w-0" for="compare-second-device"><span class="sr-only">Second device</span><select id="compare-second-device" class="min-h-9 w-full min-w-0 rounded-md border border-border bg-background px-1 text-xs" bind:value={secondId}>{#each devices as device (device.id)}<option value={device.id} disabled={device.id === firstId}>{device.name}</option>{/each}</select></label>
    {#each fields as field (field)}
      <div class="border-t border-border/50 py-2 font-medium text-muted">{field}</div>
      <div class="min-w-0 break-words border-t border-border/50 py-2" title={value(first, firstHealth, field)}>{value(first, firstHealth, field)}</div>
      <div class="min-w-0 break-words border-t border-border/50 py-2" title={value(second, secondHealth, field)}>{value(second, secondHealth, field)}</div>
    {/each}
  </div>
</section>
