<script lang="ts">
  import { fetchBundleStats, fetchJobDiff, fetchJobHistory, type BundleStats, type JobDiffResult, type JobHistoryEntry } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import { fmtBytesGB, fmtDurationApprox } from '../lib/format';
  import RelativeTime from './RelativeTime.svelte';

  let { open = $bindable(), bundleId, onOpenChange }: { open: boolean; bundleId: string; onOpenChange: (open: boolean) => void } = $props();

  let stats = $state<BundleStats | null>(null);
  let versions = $state<JobHistoryEntry[] | null>(null);
  let selected = $state<Set<string>>(new Set());
  let diff = $state<JobDiffResult | null>(null);
  let diffing = $state(false);

  $effect(() => {
    if (open && bundleId) {
      stats = null;
      versions = null;
      selected = new Set();
      diff = null;
      void fetchBundleStats(bundleId).then((s) => (stats = s));
      void fetchJobHistory(0, 20, bundleId, undefined, 'done').then((r) => (versions = r.history.filter((h) => h.bundleId === bundleId)));
    }
  });

  const maxFailureCount = $derived(Math.max(1, ...(stats?.failureBreakdown.map((f) => f.count) ?? [1])));

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < 2) next.add(id);
    selected = next;
    diff = null;
  }

  async function compare(): Promise<void> {
    const [a, b] = [...selected];
    if (!a || !b) return;
    diffing = true;
    try {
      diff = await fetchJobDiff(bundleId, a, b);
    } finally {
      diffing = false;
    }
  }
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
    {#if versions && versions.length > 0}
      <div class="border-border mt-3 border-t pt-3">
        <div class="mb-2 flex items-center justify-between gap-2">
          <span class="text-xs text-muted">Versions - pick 2 to compare</span>
          {#if selected.size === 2}
            <Button size="sm" loading={diffing} onclick={compare}>Compare</Button>
          {/if}
        </div>
        <div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {#each versions as v (v.id)}
            <label class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-panel-muted">
              <input
                type="checkbox"
                checked={selected.has(v.id)}
                disabled={!selected.has(v.id) && selected.size >= 2}
                onchange={() => toggleSelect(v.id)}
              />
              <span class="min-w-0 flex-1 truncate" title={v.versionLabel ?? ''}>{v.versionLabel ?? '(no version label)'}</span>
              <span class="text-muted"><RelativeTime ms={v.finishedAt} /></span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
    {#if diff}
      <div class="border-border mt-3 border-t pt-3">
        <div class="mb-2 flex items-center justify-between text-xs">
          <span class="text-muted">Size delta</span>
          <Badge variant={diff.sizeDeltaBytes > 0 ? 'warning' : diff.sizeDeltaBytes < 0 ? 'success' : 'secondary'}>
            {diff.sizeDeltaBytes >= 0 ? '+' : ''}{fmtBytesGB(diff.sizeDeltaBytes)}
          </Badge>
        </div>
        {#if diff.plistDiff.length === 0}
          <div class="text-xs text-muted">No Info.plist differences captured between these two versions.</div>
        {:else}
          <div class="flex flex-col gap-1.5">
            {#each diff.plistDiff as row (row.key)}
              <div class="border-border rounded-md border p-2 text-xs">
                <div class="font-mono text-[11px] text-muted">{row.key}</div>
                <div class="mt-0.5 flex items-center gap-1.5">
                  <span class="text-err line-through">{row.before === undefined ? '(unset)' : String(row.before)}</span>
                  <span class="text-muted">→</span>
                  <span class="text-ok">{row.after === undefined ? '(unset)' : String(row.after)}</span>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</Dialog>
