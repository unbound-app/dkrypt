<script lang="ts">
  import Sparkline from '../../components/Sparkline.svelte';
  import { fetchDeviceHealth, fetchJobVolume, type DeviceHealth } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);

  function fmtDayLabel(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  let volume = $state<{ label: string; value: number }[] | null>(null);
  let health = $state<DeviceHealth | null>(null);

  $effect(() => {
    void fetchJobVolume(14).then((r) => {
      volume = r.days.map((d) => ({ label: fmtDayLabel(d.date), value: d.count }));
    });
  });

  $effect(() => {
    if (liveState.historyAdditions.length > 0) {
      void fetchJobVolume(14).then((r) => {
        volume = r.days.map((d) => ({ label: fmtDayLabel(d.date), value: d.count }));
      });
    }
  });

  $effect(() => {
    const load = () => void fetchDeviceHealth().then((h) => (health = h));
    load();
    const interval = setInterval(load, 20_000);
    return () => clearInterval(interval);
  });

  const total = $derived(volume?.reduce((a, d) => a + d.value, 0) ?? 0);
  const activeJobs = $derived(overview?.activeJobs.length ?? 0);
</script>

<Card title="Status">
  <div class="mb-3.5 flex flex-wrap items-center gap-1.5">
    {#if overview}
      <Badge variant={overview.schedulerEnabled ? 'success' : 'secondary'}>Scheduler {overview.schedulerEnabled ? 'on' : 'off'}</Badge>
    {/if}
    <Badge variant={activeJobs > 0 ? 'default' : 'secondary'}>{activeJobs} active job{activeJobs === 1 ? '' : 's'}</Badge>
    {#if health}
      <Badge variant={health.reachable ? 'success' : 'destructive'} title={health.error ?? undefined}>
        iDevice {health.reachable ? 'online' : 'unreachable'}
      </Badge>
      {#if health.reachable}
        <Badge variant={health.testFlightRunning ? 'default' : 'secondary'}>TestFlight {health.testFlightRunning ? 'running' : 'idle'}</Badge>
      {/if}
    {:else}
      <Badge variant="secondary">iDevice …</Badge>
    {/if}
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
      <Sparkline data={volume} width={280} ariaLabel="{total} decrypts over the last 14 days" />
    </div>
  {/if}
</Card>
