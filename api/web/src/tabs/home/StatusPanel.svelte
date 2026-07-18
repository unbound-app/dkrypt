<script lang="ts">
  import { BatteryCharging, BatteryMedium, Circle, CircleCheck, LoaderCircle, RefreshCw, Thermometer, TriangleAlert, Zap } from 'lucide-svelte';
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
  import { fmtBytesGB, fmtUntil, trendDelta } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';

  const overview = $derived(liveState.overview);
  const primaryDeviceId = $derived(overview?.devices.find((d) => d.isPrimary)?.id ?? overview?.devices[0]?.id);
  const otherDevices = $derived(overview?.devices.filter((d) => d.id !== primaryDeviceId) ?? []);

  type RunState = 'inProgress' | 'succeeded' | 'failed' | 'timedOut' | 'upToDate' | 'checkFailed';

  function runState(outcome: SchedulerRunOutcome): RunState {
    if (!outcome.triggered) return outcome.ok ? 'upToDate' : 'checkFailed';
    if (!outcome.ok) return 'failed';
    switch (outcome.runStatus) {
      case 'dispatched':
        return 'inProgress';
      case 'succeeded':
        return 'succeeded';
      case 'failed':
        return 'failed';
      case 'timed_out':
        return 'timedOut';
      default:
        // Recorded before runStatus existed - dispatch confirmed, no further detail available.
        return 'succeeded';
    }
  }

  const RUN_STATE_LABEL: Record<RunState, string> = {
    inProgress: 'Run in progress…',
    succeeded: 'Run succeeded',
    failed: 'Run failed',
    timedOut: 'Timed out waiting for run',
    upToDate: 'Up to date',
    checkFailed: 'Check failed',
  };

  // Neither the disk gauge nor the "next run in" label update on their own between overview
  // pushes (the server only sends one on job/history changes) - this tick forces a re-render.
  let now = $state(Date.now());
  $effect(() => {
    const interval = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(interval);
  });
  // Soonest next run across every schedulable watch, not just one - a single-watch install sees
  // exactly the same "next run" label it always did, multi-watch installs see the closest one.
  const nextRunAt = $derived.by(() => {
    const times = (overview?.watches ?? []).map((w) => w.nextRunAt).filter((t): t is number => t !== undefined);
    return times.length > 0 ? Math.min(...times) : undefined;
  });

  const nextRunLabel = $derived.by(() => {
    void now;
    if (!nextRunAt) return undefined;
    // A brief "in the past" window is expected right as a tick fires and before the resulting
    // overview refresh arrives - "expired" reads like something is broken, so soften it.
    if (nextRunAt <= Date.now()) return 'due any moment';
    return fmtUntil(nextRunAt);
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
    if (!primaryDeviceId) return;
    refreshingHealth = true;
    try {
      health = await fetchDeviceHealth(primaryDeviceId, true);
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
    const deviceId = primaryDeviceId;
    if (!deviceId) return;
    const load = () => void fetchDeviceHealth(deviceId).then((h) => (health = h));
    load();
    const interval = setInterval(load, 20_000);
    return () => clearInterval(interval);
  });

  let healthHistory = $state<HourlyHealthBucket[] | null>(null);
  let uptimePercent = $state<number | null>(null);

  $effect(() => {
    const deviceId = primaryDeviceId;
    if (!deviceId) return;
    const load = () =>
      void fetchDeviceHealthHistory(deviceId, 24).then((r) => {
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
    const deviceId = primaryDeviceId;
    if (!deviceId) return;
    const load = () => void fetchDeviceBatteryHistory(deviceId, 24).then((r) => (batteryHistory = r.buckets));
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
    const deviceId = primaryDeviceId;
    if (!deviceId) return;
    const load = () => void fetchDeviceTemperatureHistory(deviceId, 24).then((r) => (temperatureHistory = r.buckets));
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

  const deviceStorageColor = $derived.by(() => {
    const pct = health?.storageUsedPercent ?? 0;
    if (pct >= 0.9) return 'bg-err';
    if (pct >= 0.75) return 'bg-warn';
    return 'bg-accent';
  });

  const total = $derived(volume?.reduce((a, d) => a + d.value, 0) ?? 0);
  const volumeDeltaPct = $derived(volume ? trendDelta(volume.map((d) => d.value)) : null);

  type HealthLevel = 'ok' | 'warn' | 'err' | 'unknown';

  const overallHealth = $derived.by((): { level: HealthLevel; reasons: string[] } => {
    if (!health) return { level: 'unknown', reasons: [] };
    const reasons: string[] = [];
    let level: HealthLevel = 'ok';
    const worsen = (next: HealthLevel, reason: string) => {
      reasons.push(reason);
      if (next === 'err' || level === 'ok') level = next;
    };

    if (!health.reachable) worsen('err', 'iDevice unreachable');
    if (overview?.disk && overview.disk.usedPercent >= 0.9) worsen('err', 'Staging disk nearly full');
    else if (overview?.disk && overview.disk.usedPercent >= 0.75) worsen('warn', 'Staging disk filling up');
    if (health.storageUsedPercent !== undefined && health.storageUsedPercent >= 0.9) worsen('err', 'iDevice storage nearly full');
    else if (health.storageUsedPercent !== undefined && health.storageUsedPercent >= 0.75) worsen('warn', 'iDevice storage filling up');
    if (health.batteryTemperatureC !== undefined && health.batteryTemperatureC >= 42) worsen('err', 'Battery hot');
    else if (health.batteryTemperatureC !== undefined && health.batteryTemperatureC >= 37) worsen('warn', 'Battery warm');
    if (health.batteryPercent !== undefined && health.batteryPercent <= 20 && !health.batteryCharging) worsen('err', 'Battery critically low');
    else if (health.batteryPercent !== undefined && health.batteryPercent <= 40 && !health.batteryCharging) worsen('warn', 'Battery low');

    return { level, reasons };
  });

  const HEALTH_DOT_CLASS: Record<HealthLevel, string> = {
    ok: 'bg-ok',
    warn: 'bg-warn',
    err: 'bg-err',
    unknown: 'bg-panel-muted',
  };

  const HEALTH_LABEL: Record<HealthLevel, string> = {
    ok: 'All good',
    warn: 'Needs attention',
    err: 'Needs attention now',
    unknown: 'Checking…',
  };
  const activeJobs = $derived(overview?.activeJobs.length ?? 0);
</script>

<Card title="Status">
  {#snippet headerExtra()}
    {#if health}
      <div class="flex items-center gap-1.5 text-xs text-muted">
        <span
          class="inline-flex items-center gap-1.5"
          title={overallHealth.reasons.length > 0 ? overallHealth.reasons.join(', ') : HEALTH_LABEL[overallHealth.level]}
        >
          <span class="h-2 w-2 shrink-0 rounded-full {HEALTH_DOT_CLASS[overallHealth.level]}"></span>
          {HEALTH_LABEL[overallHealth.level]}
        </span>
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
    {#each otherDevices as d (d.id)}
      <Badge variant={d.enabled ? 'secondary' : 'secondary'} title="{d.name} - {d.enabled ? 'enabled' : 'disabled'}">{d.name}</Badge>
    {/each}
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
  {#if overview?.watches.length}
    <dl class="text-sm">
      {#each overview.watches as w (w.id)}
        <div class="border-border flex items-center gap-2.5 border-t py-2">
          <dt class="w-24 shrink-0 text-xs text-muted truncate" title={w.name ?? 'Watching'}>{w.name ?? 'Watching'}</dt>
          <dd class="min-w-0 flex-1 truncate font-mono text-[11px]" title={w.bundleId || '-'}>
            {w.bundleId || '-'}
          </dd>
          <Badge variant={w.schedulable ? 'success' : 'secondary'} class="shrink-0">{w.schedulable ? 'on' : 'off'}</Badge>
        </div>
      {/each}
      {#if nextRunLabel}
        <div class="border-border flex items-center gap-2.5 border-t py-2">
          <dt class="w-24 shrink-0 text-xs text-muted">Next run</dt>
          <dd class="min-w-0 flex-1 truncate text-[13px]">{nextRunLabel === 'due any moment' ? nextRunLabel : `in ${nextRunLabel}`}</dd>
        </div>
      {/if}
    </dl>
  {/if}
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
  {#if health?.storageUsedPercent !== undefined}
    <div class="border-border mt-3 border-t pt-3">
      <div class="mb-1.5 flex items-center justify-between text-xs text-muted">
        <span>iDevice storage</span>
        <span>
          {#if health.storageUsedBytes !== undefined && health.storageTotalBytes !== undefined}
            {fmtBytesGB(health.storageUsedBytes)} / {fmtBytesGB(health.storageTotalBytes)}
          {:else}
            {Math.round(health.storageUsedPercent * 100)}%
          {/if}
        </span>
      </div>
      <div class="bg-panel-muted h-1.5 w-full overflow-hidden rounded-full">
        <div class="h-full rounded-full {deviceStorageColor}" style="width: {Math.min(100, health.storageUsedPercent * 100)}%"></div>
      </div>
    </div>
  {/if}
  {#if volume}
    <div class="border-border mt-1 border-t pt-3">
      <div class="mb-1.5 flex items-center gap-2 text-xs text-muted">
        <span>{total} decrypt{total === 1 ? '' : 's'} · last 14 days</span>
        {#if volumeDeltaPct !== null}
          <Badge variant={volumeDeltaPct > 0 ? 'success' : volumeDeltaPct < 0 ? 'destructive' : 'secondary'} title="Second half vs first half of this window">
            {volumeDeltaPct > 0 ? '+' : ''}{volumeDeltaPct}%
          </Badge>
        {/if}
      </div>
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
    {#if state === 'inProgress'}
      <LoaderCircle class="text-accent h-3.5 w-3.5 shrink-0 animate-spin" />
    {:else if state === 'succeeded'}
      <CircleCheck class="text-ok h-3.5 w-3.5 shrink-0" />
    {:else if state === 'failed' || state === 'checkFailed'}
      <TriangleAlert class="text-err h-3.5 w-3.5 shrink-0" />
    {:else if state === 'timedOut'}
      <TriangleAlert class="text-warn h-3.5 w-3.5 shrink-0" />
    {:else}
      <Circle class="text-muted h-3.5 w-3.5 shrink-0" />
    {/if}
    <span class="text-muted w-16 shrink-0">{label}</span>
    {#if outcome.runUrl}
      <a
        href={outcome.runUrl}
        target="_blank"
        rel="noopener noreferrer"
        class="hover:underline"
        title={outcome.reason}
        aria-label="{outcome.reason} - view run on GitHub"
      >
        {RUN_STATE_LABEL[state]} ↗
      </a>
    {:else}
      <span class="truncate" title={outcome.reason}>{RUN_STATE_LABEL[state]}</span>
    {/if}
  </div>
{/snippet}
