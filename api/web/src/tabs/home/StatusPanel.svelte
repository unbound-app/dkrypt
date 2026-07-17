<script lang="ts">
  import { BatteryCharging, BatteryMedium, Circle, CircleCheck, RefreshCw, Thermometer, TriangleAlert, Zap } from 'lucide-svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import Sparkline from '../../components/Sparkline.svelte';
  import {
    fetchDeviceBatteryHistory,
    fetchDeviceHealth,
    fetchDeviceHealthHistory,
    fetchDeviceTemperatureHistory,
    fetchJobVolume,
    type DeviceHealth,
    type HourlyBatteryBucket,
    type HourlyHealthBucket,
    type HourlyTemperatureBucket,
    type SchedulerRunOutcome,
  } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Popover from '../../lib/components/ui/Popover.svelte';
  import { fmtBytesGB, fmtUntil } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);

  type RunState = 'dispatched' | 'upToDate' | 'failed';

  function runState(outcome: SchedulerRunOutcome): RunState {
    if (!outcome.ok) return 'failed';
    return outcome.triggered ? 'dispatched' : 'upToDate';
  }

  const RUN_STATE_LABEL: Record<RunState, string> = {
    dispatched: 'Dispatched',
    upToDate: 'Up to date',
    failed: 'Check failed',
  };

  // Neither the disk gauge nor the "next run in" label update on their own between overview
  // pushes (the server only sends one on job/history changes) - this tick forces a re-render.
  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });
  const nextRunLabel = $derived.by(() => {
    void now;
    if (!overview?.nextSchedulerRunAt) return undefined;
    // A brief "in the past" window is expected right as a tick fires and before the resulting
    // overview refresh arrives - "expired" reads like something is broken, so soften it.
    if (overview.nextSchedulerRunAt <= Date.now()) return 'due any moment';
    return fmtUntil(overview.nextSchedulerRunAt);
  });

  const diskColor = $derived.by(() => {
    const pct = overview?.disk?.usedPercent ?? 0;
    if (pct >= 0.9) return 'bg-err';
    if (pct >= 0.75) return 'bg-warn';
    return 'bg-accent';
  });

  function thermalBadgeVariant(tempC: number): 'destructive' | 'warning' | 'secondary' {
    if (tempC >= 42) return 'destructive';
    if (tempC >= 37) return 'warning';
    return 'secondary';
  }

  function fmtDayLabel(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  let volume = $state<{ label: string; value: number }[] | null>(null);
  let health = $state<DeviceHealth | null>(null);
  let refreshingHealth = $state(false);

  async function refreshHealth(): Promise<void> {
    refreshingHealth = true;
    try {
      health = await fetchDeviceHealth(true);
    } finally {
      refreshingHealth = false;
    }
  }

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

  let batteryHistory = $state<HourlyBatteryBucket[] | null>(null);

  $effect(() => {
    const load = () => void fetchDeviceBatteryHistory(24).then((r) => (batteryHistory = r.buckets));
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  });

  function batteryBucketColor(pct: number | null): string {
    if (pct === null) return 'bg-panel-muted';
    if (pct <= 20) return 'bg-err';
    if (pct <= 40) return 'bg-warn';
    return 'bg-ok';
  }

  function batteryBucketTitle(bucket: HourlyBatteryBucket): string {
    const time = new Date(bucket.hourStart).toLocaleString(undefined, { hour: 'numeric', month: 'short', day: 'numeric' });
    if (bucket.batteryPercent === null) return `${time}: no data`;
    return `${time}: ${bucket.batteryPercent}%`;
  }

  const hasBatteryHistory = $derived(batteryHistory?.some((b) => b.batteryPercent !== null) ?? false);

  let temperatureHistory = $state<HourlyTemperatureBucket[] | null>(null);

  $effect(() => {
    const load = () => void fetchDeviceTemperatureHistory(24).then((r) => (temperatureHistory = r.buckets));
    load();
    const interval = setInterval(load, 60_000);
    return () => clearInterval(interval);
  });

  function temperatureBucketColor(tempC: number | null): string {
    if (tempC === null) return 'bg-panel-muted';
    if (tempC >= 42) return 'bg-err';
    if (tempC >= 37) return 'bg-warn';
    return 'bg-ok';
  }

  function temperatureBucketTitle(bucket: HourlyTemperatureBucket): string {
    const time = new Date(bucket.hourStart).toLocaleString(undefined, { hour: 'numeric', month: 'short', day: 'numeric' });
    if (bucket.batteryTemperatureC === null) return `${time}: no data`;
    return `${time}: ${bucket.batteryTemperatureC.toFixed(1)}°C`;
  }

  const hasTemperatureHistory = $derived(temperatureHistory?.some((b) => b.batteryTemperatureC !== null) ?? false);

  const total = $derived(volume?.reduce((a, d) => a + d.value, 0) ?? 0);
  const activeJobs = $derived(overview?.activeJobs.length ?? 0);
</script>

<Card title="Status">
  {#snippet headerExtra()}
    {#if health}
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span>Checked <RelativeTime ms={health.checkedAt} /></span>
        <button
          type="button"
          class="hover:text-text disabled:opacity-50"
          disabled={refreshingHealth}
          onclick={refreshHealth}
          aria-label="Refresh device status"
          title="Refresh device status"
        >
          <RefreshCw class="h-3.5 w-3.5 {refreshingHealth ? 'animate-spin' : ''}" />
        </button>
      </div>
    {/if}
  {/snippet}
  <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
    {#if overview}
      <Badge variant={overview.schedulerEnabled ? 'success' : 'secondary'}>Scheduler {overview.schedulerEnabled ? 'on' : 'off'}</Badge>
    {/if}
    <Badge variant={activeJobs > 0 ? 'default' : 'secondary'}>{activeJobs} active job{activeJobs === 1 ? '' : 's'}</Badge>
  </div>
  <div class="mb-1.5 flex flex-wrap items-center gap-1.5">
    {#if health}
      {@const h = health}
      <Badge variant={h.reachable ? 'success' : 'destructive'} title={h.error ?? undefined}>
        iDevice {h.reachable ? 'online' : 'unreachable'}
      </Badge>
      {#if h.reachable}
        <Badge variant={h.testFlightRunning ? 'default' : 'secondary'}>TestFlight {h.testFlightRunning ? 'running' : 'idle'}</Badge>
      {/if}
    {:else}
      <Badge variant="secondary">iDevice …</Badge>
    {/if}
  </div>
  {#if health}
    {@const h = health}
    {#if h.reachable && (h.batteryPercent !== undefined || h.batteryTemperatureC !== undefined)}
      <div class="mb-3.5 flex flex-wrap items-center gap-1.5">
        {#if h.batteryPercent !== undefined}
          <Popover>
            {#snippet trigger()}
              <Badge variant={h.batteryPercent !== undefined && h.batteryPercent <= 20 && !h.batteryCharging ? 'destructive' : 'secondary'}>
                {#if h.batteryCharging}
                  <BatteryCharging class="mr-1 inline h-3 w-3" />
                {:else}
                  <BatteryMedium class="mr-1 inline h-3 w-3" />
                {/if}
                {h.batteryPercent}%
              </Badge>
            {/snippet}
            <div class="flex flex-col gap-1 whitespace-nowrap">
              {#if h.batteryHealthPercent !== undefined}
                <div><span class="text-muted">Battery health</span> · {h.batteryHealthPercent}%</div>
              {/if}
              {#if h.batteryCycleCount !== undefined}
                <div><span class="text-muted">Cycle count</span> · {h.batteryCycleCount}</div>
              {/if}
              {#if h.batteryMaxCapacityMah !== undefined && h.batteryDesignCapacityMah !== undefined}
                <div><span class="text-muted">Capacity</span> · {h.batteryMaxCapacityMah} / {h.batteryDesignCapacityMah} mAh</div>
              {/if}
            </div>
          </Popover>
        {/if}
        {#if h.batteryTemperatureC !== undefined}
          <Badge variant={thermalBadgeVariant(h.batteryTemperatureC)}>
            <Thermometer class="mr-1 inline h-3 w-3" />
            {h.batteryTemperatureC.toFixed(1)}°C
            {#if h.batteryCharging}
              <Zap class="ml-1 inline h-3 w-3" />
            {/if}
          </Badge>
        {/if}
      </div>
    {/if}
  {/if}
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
  {#if hasBatteryHistory}
    <div class="mb-3.5">
      <div class="mb-1.5 text-xs text-muted">Battery · last 24h</div>
      <div class="flex gap-0.5">
        {#each batteryHistory ?? [] as bucket (bucket.hourStart)}
          <div class="h-4 flex-1 rounded-sm {batteryBucketColor(bucket.batteryPercent)}" title={batteryBucketTitle(bucket)}></div>
        {/each}
      </div>
    </div>
  {/if}
  {#if hasTemperatureHistory}
    <div class="mb-3.5">
      <div class="mb-1.5 text-xs text-muted">Temperature · last 24h</div>
      <div class="flex gap-0.5">
        {#each temperatureHistory ?? [] as bucket (bucket.hourStart)}
          <div class="h-4 flex-1 rounded-sm {temperatureBucketColor(bucket.batteryTemperatureC)}" title={temperatureBucketTitle(bucket)}></div>
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
        <dd class="min-w-0 flex-1 truncate text-[13px]">{nextRunLabel === 'due any moment' ? nextRunLabel : `in ${nextRunLabel}`}</dd>
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
      <div class="mb-1.5 text-xs text-muted">Recent scheduler checks</div>
      <div class="flex flex-col gap-1.5">
        {#each overview.schedulerRunHistory as run (run.ts)}
          <div class="border-border rounded-md border px-2.5 py-2 text-xs">
            <div class="mb-1 text-muted"><RelativeTime ms={run.ts} /></div>
            <div class="flex flex-col gap-1">
              {@render sourceRow('App Store', run.appStore)}
              {@render sourceRow('TestFlight', run.testflight)}
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Card>

{#snippet sourceRow(label: string, outcome: SchedulerRunOutcome)}
  {@const state = runState(outcome)}
  <div class="flex items-center gap-1.5">
    {#if state === 'dispatched'}
      <CircleCheck class="text-ok h-3.5 w-3.5 shrink-0" />
    {:else if state === 'failed'}
      <TriangleAlert class="text-err h-3.5 w-3.5 shrink-0" />
    {:else}
      <Circle class="text-muted h-3.5 w-3.5 shrink-0" />
    {/if}
    <span class="text-muted w-16 shrink-0">{label}</span>
    {#if outcome.runUrl}
      <a href={outcome.runUrl} target="_blank" rel="noopener noreferrer" class="hover:underline" title="{outcome.reason} - view run on GitHub">
        Dispatched ↗
      </a>
    {:else}
      <span class="truncate" title={outcome.reason}>{RUN_STATE_LABEL[state]}</span>
    {/if}
  </div>
{/snippet}
