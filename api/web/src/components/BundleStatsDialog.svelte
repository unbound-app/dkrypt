<script lang="ts">
  import { fetchBundleStats, type BundleStats } from '../lib/api';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import { fmtDurationApprox } from '../lib/format';
  import RelativeTime from './RelativeTime.svelte';

  let { open = $bindable(), bundleId, onOpenChange }: { open: boolean; bundleId: string; onOpenChange: (open: boolean) => void } = $props();

  let stats = $state<BundleStats | null>(null);

  $effect(() => {
    if (open && bundleId) {
      stats = null;
      void fetchBundleStats(bundleId).then((s) => (stats = s));
    }
  });

  const maxFailureCount = $derived(Math.max(1, ...(stats?.failureBreakdown.map((f) => f.count) ?? [1])));
</script>

<Dialog {open} {onOpenChange} class="max-w-sm">
  <div class="mb-3 truncate font-mono text-[13px] font-medium" title={bundleId}>{bundleId}</div>
  {#if !stats}
    <div class="text-sm text-muted">Loading…</div>
  {:else if stats.totalRuns === 0}
    <div class="text-sm text-muted">No decrypt history for this bundle ID yet.</div>
  {:else}
    <dl class="flex flex-col gap-2 text-sm">
      <div class="flex items-center justify-between">
        <dt class="text-muted">Total runs</dt>
        <dd>{stats.totalRuns}</dd>
      </div>
      <div class="flex items-center justify-between">
        <dt class="text-muted">Success rate</dt>
        <dd>{Math.round(stats.successRate * 100)}% ({stats.doneCount} done, {stats.failedCount} failed)</dd>
      </div>
      <div class="flex items-center justify-between">
        <dt class="text-muted">Avg duration</dt>
        <dd>{stats.avgDurationMs ? fmtDurationApprox(stats.avgDurationMs) : '-'}</dd>
      </div>
      <div class="flex items-center justify-between">
        <dt class="text-muted">Last run</dt>
        <dd>{#if stats.lastRunAt}<RelativeTime ms={stats.lastRunAt} />{:else}-{/if}</dd>
      </div>
    </dl>
    {#if stats.failureBreakdown.length > 0}
      <div class="border-border mt-3 border-t pt-3">
        <div class="mb-2 text-xs text-muted">Failure reasons</div>
        <div class="flex flex-col gap-1.5">
          {#each stats.failureBreakdown as f (f.category)}
            <div class="flex items-center gap-2.5">
              <span class="w-24 shrink-0 truncate text-xs" title={f.category}>{f.category}</span>
              <div class="bg-panel-muted h-2 flex-1 overflow-hidden rounded-full">
                <div class="bg-err h-full rounded-full" style="width: {(f.count / maxFailureCount) * 100}%"></div>
              </div>
              <span class="w-6 shrink-0 text-right text-xs text-muted">{f.count}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</Dialog>
