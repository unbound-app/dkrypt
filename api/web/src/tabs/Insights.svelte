<script lang="ts">
  import { BarChart3, TriangleAlert } from 'lucide-svelte';
  import BundleStatsDialog from '../components/BundleStatsDialog.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import { fetchInsights, fetchWatchHealth, type InsightsSummary, type WatchHealthSummary } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import Select from '../lib/components/ui/Select.svelte';
  import { csvCell, downloadBlob, fmtBytesGB, fmtDurationApprox, trendDelta } from '../lib/format';
  import { liveState } from '../lib/live.svelte';
  import { PermissionFlag } from '../lib/permissions';
  import { sessionHasAnyPermission } from '../lib/session.svelte';
  import RelativeTime from '../components/RelativeTime.svelte';

  const TREND_DAYS_OPTIONS = [
    { value: '7', label: 'Last 7 days' },
    { value: '14', label: 'Last 14 days' },
    { value: '30', label: 'Last 30 days' },
    { value: '60', label: 'Last 60 days' },
    { value: '90', label: 'Last 90 days' },
  ];

  const TOP_APPS_OPTIONS = [
    { value: '5', label: 'Top 5' },
    { value: '10', label: 'Top 10' },
    { value: '15', label: 'Top 15' },
    { value: '25', label: 'Top 25' },
  ];

  let insights = $state<InsightsSummary | null>(null);
  let trendDays = $state('14');
  let topAppsLimit = $state('5');

  const canViewScheduler = $derived(
    sessionHasAnyPermission([PermissionFlag.viewAutomation, PermissionFlag.manageAutomation, PermissionFlag.manageDevices]),
  );
  let watchHealth = $state<WatchHealthSummary[] | null>(null);

  $effect(() => {
    if (!canViewScheduler) return;
    void fetchWatchHealth().then((r) => (watchHealth = r.watches));
  });

  const flaggedWatches = $derived(
    (watchHealth ?? []).filter((w) => w.schedulable && (w.consecutiveFailures >= 3 || (w.historyCount > 0 && !w.everTriggeredInHistory))),
  );

  function load(): void {
    void fetchInsights(Number(trendDays), Number(topAppsLimit)).then((r) => (insights = r));
  }

  $effect(() => {
    void trendDays;
    void topAppsLimit;
    load();
  });

  $effect(() => {
    if (liveState.historyAdditions.length > 0) load();
  });

  function fmtDayLabel(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const trend = $derived(insights?.trend.map((d) => ({ label: fmtDayLabel(d.date), value: d.count })) ?? []);
  const trendDeltaPct = $derived(trendDelta(trend.map((d) => d.value)));
  const maxFailureCount = $derived(Math.max(1, ...(insights?.failureBreakdown.map((f) => f.count) ?? [1])));

  let statsOpen = $state(false);
  let statsBundleId = $state('');

  function openStats(bundleId: string): void {
    statsBundleId = bundleId;
    statsOpen = true;
  }

  function exportCsv(): void {
    if (!insights) return;
    const rows = ['bundleId,totalRuns,doneCount,failedCount,successRate,totalSizeBytes'];
    for (const app of insights.topApps) {
      rows.push([app.bundleId, app.totalRuns, app.doneCount, app.failedCount, app.successRate, app.totalSizeBytes].map(csvCell).join(','));
    }
    downloadBlob(rows.join('\n'), 'dkrypt-insights.csv', 'text/csv');
  }

  function exportJson(): void {
    if (!insights) return;
    downloadBlob(JSON.stringify(insights, null, 2), 'dkrypt-insights.json', 'application/json');
  }
</script>

<Card title="Insights">
  {#snippet headerExtra()}
    {#if insights && insights.totalRuns > 0}
      <div class="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" onclick={exportCsv}>Export CSV</Button>
        <Button size="sm" variant="secondary" onclick={exportJson}>Export JSON</Button>
      </div>
    {/if}
  {/snippet}
  {#if !insights}
    <div class="flex flex-col gap-1.5">
      {#each Array(4) as _, i (i)}
        <div class="skeleton bg-panel-muted h-12 rounded-md"></div>
      {/each}
    </div>
  {:else if insights.totalRuns === 0}
    <EmptyState icon={BarChart3} message="No decrypts yet - insights will show up once some have run." />
  {:else}
    <div class="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <div class="border-border rounded-lg border p-3">
        <div class="text-xs text-muted">Total runs</div>
        <div class="text-xl font-semibold">{insights.totalRuns}</div>
      </div>
      <div class="border-border rounded-lg border p-3">
        <div class="text-xs text-muted">Success rate</div>
        <div class="text-xl font-semibold">{Math.round(insights.successRate * 100)}%</div>
      </div>
      <div class="border-border rounded-lg border p-3">
        <div class="text-xs text-muted">Total size decrypted</div>
        <div class="text-xl font-semibold">{fmtBytesGB(insights.totalSizeBytes)}</div>
      </div>
      <div class="border-border rounded-lg border p-3">
        <div class="text-xs text-muted">Manual / scheduler</div>
        <div class="text-xl font-semibold">{insights.manualCount} / {insights.schedulerCount}</div>
      </div>
    </div>

    <div class="border-border mb-4 border-t pt-3">
      <div class="mb-1.5 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 text-xs text-muted">
          <span>Decrypts · last {trendDays} days</span>
          {#if trendDeltaPct !== null}
            <Badge variant={trendDeltaPct > 0 ? 'success' : trendDeltaPct < 0 ? 'destructive' : 'secondary'} title="Second half vs first half of this window">
              {trendDeltaPct > 0 ? '+' : ''}{trendDeltaPct}%
            </Badge>
          {/if}
        </div>
        <Select items={TREND_DAYS_OPTIONS} bind:value={trendDays} class="w-36" />
      </div>
      <div class="overflow-x-auto">
        <Sparkline data={trend} width={560} ariaLabel="Decrypt volume over the last {trendDays} days" />
      </div>
    </div>

    {#if insights.failureBreakdown.length > 0}
      <div class="border-border mb-4 border-t pt-3">
        <div class="mb-2 text-xs text-muted">Failure reasons</div>
        <div class="flex flex-col gap-1.5">
          {#each insights.failureBreakdown as f (f.category)}
            <div class="flex items-center gap-2.5">
              <span class="w-32 shrink-0 truncate text-xs" title={f.category}>{f.category}</span>
              <div class="bg-panel-muted h-2 flex-1 overflow-hidden rounded-full">
                <div class="bg-err h-full rounded-full" style="width: {(f.count / maxFailureCount) * 100}%"></div>
              </div>
              <span class="w-6 shrink-0 text-right text-xs text-muted">{f.count}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}

    <div class="border-border border-t pt-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="text-xs text-muted">Busiest apps</div>
        <Select items={TOP_APPS_OPTIONS} bind:value={topAppsLimit} class="w-32" />
      </div>
      <table class="responsive-table">
        <thead>
          <tr>
            <th>Bundle ID</th>
            <th>Runs</th>
            <th>Success rate</th>
            <th>Size</th>
          </tr>
        </thead>
        <tbody>
          {#each insights.topApps as app (app.bundleId)}
            <tr>
              <td data-label="Bundle ID" class="max-w-56">
                <button
                  class="block max-w-full truncate cursor-pointer text-left font-mono text-[11px] hover:text-accent hover:underline"
                  title="View stats for {app.bundleId}"
                  onclick={() => openStats(app.bundleId)}
                >
                  {app.bundleId}
                </button>
              </td>
              <td data-label="Runs">{app.totalRuns}</td>
              <td data-label="Success rate">
                <Badge variant={app.successRate >= 0.9 ? 'success' : app.successRate >= 0.5 ? 'secondary' : 'destructive'}>
                  {Math.round(app.successRate * 100)}%
                </Badge>
              </td>
              <td data-label="Size" class="text-muted">{fmtBytesGB(app.totalSizeBytes)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if insights.byDevice.length > 1}
      <div class="border-border mt-4 border-t pt-3">
        <div class="mb-2 text-xs text-muted">By device</div>
        <table class="responsive-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Runs</th>
              <th>Success rate</th>
              <th>Avg duration</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {#each insights.byDevice as d (d.deviceId)}
              <tr>
                <td data-label="Device" class="max-w-40 truncate" title={d.deviceId}>
                  {d.deviceName}
                  {#if d.removed}<span class="text-muted"> (removed)</span>{/if}
                </td>
                <td data-label="Runs">{d.totalRuns}</td>
                <td data-label="Success rate">
                  <Badge variant={d.successRate >= 0.9 ? 'success' : d.successRate >= 0.5 ? 'secondary' : 'destructive'}>
                    {Math.round(d.successRate * 100)}%
                  </Badge>
                </td>
                <td data-label="Avg duration" class="text-muted">{d.avgDurationMs ? fmtDurationApprox(d.avgDurationMs) : '-'}</td>
                <td data-label="Size" class="text-muted">{fmtBytesGB(d.totalSizeBytes)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</Card>

{#if canViewScheduler && watchHealth !== null && watchHealth.some((w) => w.schedulable)}
  <Card title="Watch health" class="mt-4">
    {#if flaggedWatches.length === 0}
      <EmptyState message="All watches are checking in fine - no repeated failures, all have found a match before." />
    {:else}
      <div class="flex flex-col gap-1.5">
        {#each flaggedWatches as w (w.watchId)}
          <div class="border-border flex items-center gap-2.5 rounded-md border px-2.5 py-2 text-xs">
            <TriangleAlert class="text-warn h-3.5 w-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate font-mono" title={w.bundleId}>{w.name || w.bundleId}</span>
            {#if w.consecutiveFailures >= 3}
              <Badge variant="destructive">{w.consecutiveFailures} checks failed in a row</Badge>
            {:else}
              <Badge variant="secondary">no match in visible history ({w.historyCount} checks)</Badge>
            {/if}
            {#if w.lastCheckAt}
              <span class="text-muted"><RelativeTime ms={w.lastCheckAt} /></span>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </Card>
{/if}

<BundleStatsDialog open={statsOpen} bundleId={statsBundleId} onOpenChange={(v) => (statsOpen = v)} />
