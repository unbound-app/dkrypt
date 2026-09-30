<script lang="ts">
  import { WifiOff } from 'lucide-svelte';
  import { liveState, reconnectLive } from '#lib/live.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';

  const showWarning = $derived(
    liveState.stale ||
      liveState.sequenceGap ||
      liveState.overviewRefreshFailed ||
      (liveState.disconnectedAt !== null && !liveState.connected),
  );
</script>

{#if showWarning}
  <Alert variant="warning" class="mb-4 flex items-center gap-2.5 py-3 text-[13px]" role="status" aria-live="polite">
    <WifiOff class="h-4 w-4 shrink-0" />
    <span class="flex-1">
      {#if liveState.overviewRefreshFailed}
        Dashboard data refresh failed. Try again.
      {:else if liveState.sequenceGap && liveState.connected}
        Live updates skipped a sequence - refreshing…
      {:else if liveState.connected && liveState.stale}
        Reconnected - refreshing data…
      {:else}
        Disconnected - data may be stale. Reconnecting…
      {/if}
      {#if liveState.disconnectedAt && !liveState.connected}
        (down since <RelativeTime ms={liveState.disconnectedAt} />{#if liveState.reconnectAttempts > 1}, {liveState.reconnectAttempts} attempts{/if})
      {/if}
    </span>
    <Button variant="secondary" size="sm" onclick={() => reconnectLive()}>
      {liveState.overviewRefreshFailed ? 'Retry refresh' : 'Reconnect now'}
    </Button>
  </Alert>
{/if}
