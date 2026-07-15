<script lang="ts">
  import Card from '../../lib/components/ui/Card.svelte';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);
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
      <dd class="min-w-0 flex-1 truncate font-mono text-[13px]" title={overview?.settings.watchBundleId || '-'}>
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
</Card>
