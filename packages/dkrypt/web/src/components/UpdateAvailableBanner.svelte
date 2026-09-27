<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { applyPwaUpdate, pwaState } from '#lib/pwa.svelte';
</script>

{#if pwaState.updateAvailable}
  <Alert class="mb-4 flex items-center gap-2.5 border-primary/30 bg-primary/10 px-3.5 py-3 text-[13px]" role="status" aria-live="polite">
    <RefreshCw class="h-4 w-4 shrink-0" />
    <span class="flex-1">
      {#if pwaState.updateStatus === 'applying'}
        Activating the update…
      {:else if pwaState.updateStatus === 'failed'}
        The update has not taken control yet. Try again shortly.
      {:else if pwaState.updateStatus === 'ready'}
        The update is ready. Reload to finish.
      {:else}
        A new version of dkrypt is available.
      {/if}
    </span>
    <Button size="sm" loading={pwaState.updateStatus === 'applying'} onclick={applyPwaUpdate}>
      {pwaState.updateStatus === 'failed' ? 'Try again' : pwaState.updateStatus === 'ready' ? 'Reload now' : 'Reload to update'}
    </Button>
  </Alert>
{/if}
