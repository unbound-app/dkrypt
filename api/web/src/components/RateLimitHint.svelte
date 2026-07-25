<script lang="ts">
  import { rateLimitState } from '#lib/api';

  let { bucket }: { bucket: string } = $props();

  const info = $derived(rateLimitState[bucket]);

  let now = $state(Date.now());
  $effect(() => {
    if (!info || info.remaining > 0) return;
    const interval = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(interval);
  });

  const secondsLeft = $derived(info ? Math.max(0, Math.ceil((info.resetAt - now) / 1000)) : 0);
</script>

{#if info && info.remaining <= 3}
  <div class="text-warn text-xs">
    {#if info.remaining === 0}
      Rate limited - try again in {secondsLeft}s
    {:else}
      {info.remaining} request{info.remaining === 1 ? '' : 's'} left this minute
    {/if}
  </div>
{/if}
