<script lang="ts">
  import { BarChart3 } from 'lucide-svelte';
  import BundleStatsDialog from '../components/BundleStatsDialog.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import Sparkline from '../components/Sparkline.svelte';
  import { fetchInsights, type InsightsSummary } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import { fmtBytesGB } from '../lib/format';
  import { liveState } from '../lib/live.svelte';

  let insights = $state<InsightsSummary | null>(null);

  function load(): void {
    void fetchInsights().then((r) => (insights = r));
  }

  $effect(() => {
    load();
  });

  $effect(() => {
    if (liveState.historyAdditions.length > 0) load();
  });

  function fmtDayLabel(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  const trend = $derived(insights?.trend.map((d) => ({ label: fmtDayLabel(d.date), value: d.count })) ?? []);

  let statsOpen = $state(false);
  let statsBundleId = $state('');

  function openStats(bundleId: string): void {
    statsBundleId = bundleId;
    statsOpen = true;
  }
</script>

<Card title="Insights">
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
      <div class="mb-1.5 text-xs text-muted">Decrypts · last 14 days</div>
      <div class="overflow-x-auto">
        <Sparkline data={trend} width={560} ariaLabel="Decrypt volume over the last 14 days" />
      </div>
    </div>

    <div class="border-border border-t pt-3">
      <div class="mb-2 text-xs text-muted">Busiest apps</div>
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
                  class="block max-w-full truncate cursor-pointer text-left hover:text-accent hover:underline"
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
  {/if}
</Card>

<BundleStatsDialog open={statsOpen} bundleId={statsBundleId} onOpenChange={(v) => (statsOpen = v)} />
