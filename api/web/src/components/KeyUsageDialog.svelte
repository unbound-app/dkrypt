<script lang="ts">
  import { fetchKeyUsage, type ApiKeyUsageBucket } from '../lib/api';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import Sparkline from './Sparkline.svelte';

  let { open = $bindable(), keyId, keyName, onOpenChange }: { open: boolean; keyId: string; keyName: string; onOpenChange: (open: boolean) => void } = $props();

  let usage = $state<ApiKeyUsageBucket[] | null>(null);

  $effect(() => {
    if (open && keyId) {
      usage = null;
      void fetchKeyUsage(keyId, 14).then((r) => (usage = r.usage));
    }
  });

  function fmtDayLabel(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const total = $derived(usage?.reduce((a, d) => a + d.count, 0) ?? 0);
</script>

<Dialog {open} {onOpenChange} class="max-w-sm">
  <div class="mb-3 truncate text-sm font-medium" title={keyName}>{keyName} - usage</div>
  {#if !usage}
    <div class="text-sm text-muted">Loading…</div>
  {:else if total === 0}
    <div class="text-sm text-muted">No requests with this key in the last 14 days.</div>
  {:else}
    <div class="mb-1.5 text-xs text-muted">{total} request{total === 1 ? '' : 's'} · last 14 days</div>
    <Sparkline
      data={usage.map((d) => ({ label: fmtDayLabel(d.date), value: d.count }))}
      width={300}
      ariaLabel="{total} requests over the last 14 days"
    />
  {/if}
</Dialog>
