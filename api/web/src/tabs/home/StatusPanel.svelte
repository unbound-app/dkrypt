<script lang="ts">
  import Sparkline from '../../components/Sparkline.svelte';
  import { fetchJobVolume } from '../../lib/api';
  import Card from '../../lib/components/ui/Card.svelte';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);

  let volume = $state<number[] | null>(null);

  $effect(() => {
    void fetchJobVolume(14).then((r) => {
      volume = r.days.map((d) => d.count);
    });
  });

  $effect(() => {
    if (liveState.historyAdditions.length > 0) {
      void fetchJobVolume(14).then((r) => {
        volume = r.days.map((d) => d.count);
      });
    }
  });

  const total = $derived(volume?.reduce((a, b) => a + b, 0) ?? 0);
</script>

<Card title="Status">
  <div class="mb-3.5 grid grid-cols-2 gap-3">
    <div>
      <div class="text-[26px] font-semibold">{overview ? (overview.schedulerEnabled ? 'On' : 'Off') : '-'}</div>
      <div class="text-xs text-muted">Scheduler</div>
    </div>
    <div>
      <div class="text-[26px] font-semibold">{overview ? overview.activeJobs.length : '-'}</div>
      <div class="text-xs text-muted">Active jobs</div>
    </div>
  </div>
  <dl class="text-sm">
    <div class="border-border flex items-center gap-2.5 border-t py-2">
      <dt class="w-24 shrink-0 text-xs text-muted">Watching</dt>
      <dd class="min-w-0 flex-1 truncate font-mono text-[11px]" title={overview?.settings.watchBundleId || '-'}>
        {overview?.settings.watchBundleId || '-'}
      </dd>
    </div>
    <div class="border-border flex items-center gap-2.5 border-t py-2">
      <dt class="w-24 shrink-0 text-xs text-muted">Poll cron</dt>
      <dd class="min-w-0 flex-1 truncate font-mono text-[13px]" title={overview?.settings.pollCron || '-'}>
        {overview?.settings.pollCron || '-'}
      </dd>
    </div>
  </dl>
  {#if volume}
    <div class="border-border mt-1 border-t pt-3">
      <div class="mb-1.5 text-xs text-muted">{total} decrypt{total === 1 ? '' : 's'} · last 14 days</div>
      <Sparkline data={volume} width={280} />
    </div>
  {/if}
</Card>
