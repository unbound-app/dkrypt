<script lang="ts">
  import { Wrench } from 'lucide-svelte';
  import { liveState } from '#lib/live.svelte';

  const maintenance = $derived(liveState.overview?.maintenance);
</script>

{#if maintenance?.active}
  <div class="mb-4 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn">
    <Wrench class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      <div class="font-medium">Maintenance mode — decrypts and the API are paused.</div>
      {#if maintenance.reason}
        <div class="text-warn/80 mt-0.5">{maintenance.reason}{maintenance.auto && !maintenance.manual ? ' (engaged automatically)' : ''}.</div>
      {/if}
    </div>
  </div>
{/if}
