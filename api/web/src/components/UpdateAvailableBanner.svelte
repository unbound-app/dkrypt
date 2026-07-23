<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import { applyPwaUpdate, pwaState } from '../lib/pwa.svelte';
</script>

{#if pwaState.updateAvailable}
  <div class="mb-4 flex items-center gap-2.5 rounded-lg border border-accent/40 bg-accent/10 px-3.5 py-3 text-[13px]" role="status" aria-live="polite">
    <RefreshCw class="h-4 w-4 shrink-0" />
    <span class="flex-1">A new version of dkrypt is available.</span>
    <Button size="sm" onclick={applyPwaUpdate}>Reload to update</Button>
  </div>
{/if}
