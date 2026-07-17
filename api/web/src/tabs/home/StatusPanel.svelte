<script lang="ts">
  import RelativeTime from '../../components/RelativeTime.svelte';
  import Sparkline from '../../components/Sparkline.svelte';
  import { fetchDeviceHealth, fetchDeviceHealthHistory, fetchJobVolume, type DeviceHealth, type HourlyHealthBucket } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { fmtBytesGB, fmtUntil } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);

  // Neither the disk gauge nor the "next run in" label update on their own between overview
  // pushes (the server only sends one on job/history changes) - this tick forces a re-render.
  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });
  const nextRunLabel = $derived.by(() => {
    void now;
    return overview?.nextSchedulerRunAt ? fmtUntil(overview.nextSchedulerRunAt) : undefined;
  });

  const diskColor = $derived.by(() => {
    const pct = overview?.disk?.usedPercent ?? 0;
    if (pct >= 0.9) return 'bg-err';
    if (pct >= 0.75) return 'bg-warn';
    return 'bg-accent';
  });

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

  let healthHistory = $state<HourlyHealthBucket[] | null>(null);
  let uptimePercent = $state<number | null>(null);

  $effect(() => {
    const load = () =>
      void fetchDeviceHealthHistory(24).then((r) => {
        healthHistory = r.buckets;
        uptimePercent = r.uptimePercent;
      });
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  });

  function bucketColor(pct: number | null): string {
    if (pct === null) return 'bg-panel-muted';
    if (pct >= 0.95) return 'bg-ok';
    if (pct > 0) return 'bg-warn';
    return 'bg-err';
  }

  function bucketTitle(bucket: HourlyHealthBucket): string {
    const time = new Date(bucket.hourStart).toLocaleString(undefined, { hour: 'numeric', month: 'short', day: 'numeric' });
    if (bucket.reachablePercent === null) return `${time}: no data`;
    return `${time}: ${Math.round(bucket.reachablePercent * 100)}% reachable`;
  }

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
  {#if healthHistory}
    <div class="mb-3.5">
      <div class="mb-1.5 flex items-center justify-between text-xs text-muted">
        <span>Device reachability · last 24h</span>
        {#if uptimePercent !== null}
          <span>{Math.round(uptimePercent * 100)}% uptime</span>
        {/if}
      </div>
      <div class="flex gap-0.5">
        {#each healthHistory as bucket (bucket.hourStart)}
          <div class="h-4 flex-1 rounded-sm {bucketColor(bucket.reachablePercent)}" title={bucketTitle(bucket)}></div>
        {/each}
      </div>
    </div>
  {/if}
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
    {#if nextRunLabel}
      <div class="border-border flex items-center gap-2.5 border-t py-2">
        <dt class="w-24 shrink-0 text-xs text-muted">Next run</dt>
        <dd class="min-w-0 flex-1 truncate text-[13px]">in {nextRunLabel}</dd>
      </div>
    {/if}
  </dl>
  {#if overview?.disk}
    <div class="border-border mt-1 border-t pt-3">
      <div class="mb-1.5 flex items-center justify-between text-xs text-muted">
        <span>Staging disk</span>
        <span>{fmtBytesGB(overview.disk.usedBytes)} / {fmtBytesGB(overview.disk.totalBytes)}</span>
      </div>
      <div class="bg-panel-muted h-1.5 w-full overflow-hidden rounded-full">
        <div class="h-full rounded-full {diskColor}" style="width: {Math.min(100, overview.disk.usedPercent * 100)}%"></div>
      </div>
    </div>
  {/if}
  {#if volume}
    <div class="border-border mt-1 border-t pt-3">
      <div class="mb-1.5 text-xs text-muted">{total} decrypt{total === 1 ? '' : 's'} · last 14 days</div>
      <Sparkline data={volume} width={280} ariaLabel="{total} decrypts over the last 14 days" />
    </div>
  {/if}
  {#if overview?.schedulerRunHistory?.length}
    <div class="border-border mt-3 border-t pt-3">
      <div class="mb-1.5 text-xs text-muted">Last {overview.schedulerRunHistory.length} scheduler runs</div>
      <div class="flex flex-col gap-1">
        {#each overview.schedulerRunHistory as run (run.ts)}
          <div class="flex items-center gap-1.5 text-xs">
            <span class="w-16 shrink-0 text-muted"><RelativeTime ms={run.ts} /></span>
            {#if run.appStore.runUrl}
              <a href={run.appStore.runUrl} target="_blank" rel="noopener noreferrer" title="{run.appStore.reason} - view run on GitHub">
                <Badge variant="default" class="hover:opacity-80">App Store ↗</Badge>
              </a>
            {:else}
              <Badge variant={run.appStore.triggered ? 'default' : 'secondary'} title={run.appStore.reason}>App Store</Badge>
            {/if}
            {#if run.testflight.runUrl}
              <a href={run.testflight.runUrl} target="_blank" rel="noopener noreferrer" title="{run.testflight.reason} - view run on GitHub">
                <Badge variant="default" class="hover:opacity-80">TestFlight ↗</Badge>
              </a>
            {:else}
              <Badge variant={run.testflight.triggered ? 'default' : 'secondary'} title={run.testflight.reason}>TestFlight</Badge>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Card>
