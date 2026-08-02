<script lang="ts">
  import { CheckCircle2, CircleAlert, ListChecks } from 'lucide-svelte';
  import type { BulkJobPreview } from '#lib/api';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtDurationApprox, fmtSize } from '#lib/format';

  interface Props {
    open: boolean;
    preview: BulkJobPreview | null;
    onOpenChange: (open: boolean) => void;
    onConfirm: () => void;
  }

  let { open, preview, onOpenChange, onConfirm }: Props = $props();
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-1 flex items-center gap-2 text-sm font-medium">
    <ListChecks class="text-accent h-4 w-4" />
    Preview bulk decrypt
  </div>
  <div class="mb-4 text-xs text-muted">Review the requests before adding anything to the queue.</div>

  {#if preview}
    <div class="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
      <div class="border-border rounded-lg border p-2.5"><div class="text-[11px] text-muted">Selected</div><div class="mt-0.5 text-sm font-medium">{preview.requested}</div></div>
      <div class="border-border rounded-lg border p-2.5"><div class="text-[11px] text-muted">Will queue</div><div class="mt-0.5 text-sm font-medium">{preview.projectedQueueAdds}</div></div>
      <div class="border-border rounded-lg border p-2.5"><div class="text-[11px] text-muted">Est. runtime</div><div class="mt-0.5 text-sm font-medium">{preview.estimatedDurationMs ? fmtDurationApprox(preview.estimatedDurationMs) : 'Unknown'}</div></div>
      <div class="border-border rounded-lg border p-2.5"><div class="text-[11px] text-muted">Previous output</div><div class="mt-0.5 text-sm font-medium">{fmtSize(preview.previousSizeBytes)}</div></div>
    </div>

    <div class="mb-4 max-h-64 overflow-y-auto rounded-lg border border-border">
      {#each preview.items as item (item.id)}
        <div class="border-border flex items-start gap-2 border-b p-2.5 last:border-b-0">
          {#if item.action === 'queue'}<CheckCircle2 class="text-ok mt-0.5 h-4 w-4 shrink-0" />{:else}<CircleAlert class="text-warn mt-0.5 h-4 w-4 shrink-0" />{/if}
          <div class="min-w-0 flex-1">
            <div class="truncate text-xs font-medium">{item.bundleId}</div>
            <div class="text-[11px] text-muted">{item.versionLabel ?? 'Current App Store release'} · {item.action === 'queue' ? 'new queue entry' : item.reason}</div>
          </div>
        </div>
      {/each}
    </div>
    <div class="flex justify-end gap-2">
      <Button size="sm" variant="secondary" onclick={() => onOpenChange(false)}>Cancel</Button>
      <Button size="sm" disabled={preview.projectedQueueAdds === 0} onclick={onConfirm}>Queue {preview.projectedQueueAdds}</Button>
    </div>
  {:else}
    <div class="text-sm text-muted">Preparing preview…</div>
  {/if}
</Dialog>
