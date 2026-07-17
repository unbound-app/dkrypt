<script lang="ts">
  import { WifiOff } from 'lucide-svelte';
  import { liveState, reconnectLive } from '../lib/live.svelte';
  import Button from '../lib/components/ui/Button.svelte';

  const showWarning = $derived(liveState.overview !== null && !liveState.connected);
</script>

{#if showWarning}
  <div class="mb-4 flex items-center gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn" role="status" aria-live="polite">
    <WifiOff class="h-4 w-4 shrink-0" />
    <span class="flex-1">Disconnected - data may be stale. Reconnecting…</span>
    <Button variant="secondary" size="sm" onclick={reconnectLive}>Reconnect now</Button>
  </div>
{/if}
