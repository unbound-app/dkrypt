<script lang="ts">
  import { CheckCircle2, CircleX, ShieldCheck } from 'lucide-svelte';
  import type { DecryptPreflight } from '#lib/api';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtDurationApprox, fmtSize } from '#lib/format';

  interface Props {
    open: boolean;
    preflight: DecryptPreflight | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }

  let { open, preflight, onOpenChange, onConfirm }: Props = $props();
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-1 flex items-center gap-2 text-sm font-medium">
    <ShieldCheck class="text-accent h-4 w-4" />
    Check before queuing
  </div>
  <div class="mb-4 text-xs text-muted">
    {preflight?.bundleId}{preflight?.versionLabel ? ` · ${preflight.versionLabel}` : ''}
    {preflight?.testflight ? ' · TestFlight' : ''}
  </div>

  {#if preflight}
    <div class="mb-4 grid grid-cols-2 gap-2">
      <div class="border-border rounded-lg border p-2.5">
        <div class="text-[11px] text-muted">Estimated run time</div>
        <div class="mt-0.5 text-sm font-medium">{preflight.estimatedDurationMs ? fmtDurationApprox(preflight.estimatedDurationMs) : 'No baseline yet'}</div>
      </div>
      <div class="border-border rounded-lg border p-2.5">
        <div class="text-[11px] text-muted">Active queue</div>
        <div class="mt-0.5 text-sm font-medium">{preflight.queueLength} job{preflight.queueLength === 1 ? '' : 's'}</div>
      </div>
    </div>

    <div class="mb-4 flex flex-col gap-2">
      {#each preflight.devices as device (device.id)}
        <div class="border-border rounded-lg border p-2.5">
          <div class="flex items-center gap-2">
            {#if device.ready}<CheckCircle2 class="text-ok h-4 w-4 shrink-0" />{:else}<CircleX class="text-err h-4 w-4 shrink-0" />{/if}
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{device.name}</span>
            {#if device.isPrimary}<span class="text-[11px] text-muted">Primary</span>{/if}
            {#if device.storageFreeBytes !== undefined}<span class="text-[11px] text-muted">{fmtSize(device.storageFreeBytes)} free</span>{/if}
          </div>
          {#if device.blockers.length > 0}
            <div class="mt-1.5 text-xs text-err">{device.blockers.join(' · ')}</div>
          {:else if device.readiness?.reasons.length}
            <div class="mt-1.5 text-xs text-muted">{device.readiness.reasons.join(' · ')}</div>
          {:else}
            <div class="mt-1.5 text-xs text-muted">Ready for this request</div>
          {/if}
        </div>
      {:else}
        <div class="border-warn/40 bg-warn/10 rounded-lg border p-3 text-sm text-warn">No enabled devices are configured.</div>
      {/each}
    </div>

    {#if !preflight.canQueue}
      <div class="border-warn/40 bg-warn/10 mb-4 rounded-lg border p-3 text-xs text-warn">No device currently passes every check. You can still queue this job and resolve the device issue afterward.</div>
    {/if}
    <div class="flex justify-end gap-2">
      <Button size="sm" variant="secondary" onclick={() => onOpenChange(false)}>Cancel</Button>
      <Button size="sm" onclick={onConfirm}>{preflight.canQueue ? 'Queue job' : 'Queue anyway'}</Button>
    </div>
  {:else}
    <div class="text-sm text-muted">Checking devices…</div>
  {/if}
</Dialog>
