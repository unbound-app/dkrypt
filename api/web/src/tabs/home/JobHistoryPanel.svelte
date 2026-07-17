<script lang="ts">
  import { History, X } from 'lucide-svelte';
  import BundleStatsDialog from '../../components/BundleStatsDialog.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import ShareLinkDialog from '../../components/ShareLinkDialog.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { fetchJobHistory, jobHistoryExportUrl, queueDecrypt, queueTestFlightDecrypt, type JobHistoryEntry } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { buttonVariants, statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { addDecrypt, pushRecentBundleId } from '../../lib/decrypts.svelte';
  import { csvCell, debounce, downloadBlob, fmtSize } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { scrollFade } from '../../lib/scrollFade';
  import { confirmDialog, historyJumpState, showToast } from '../../lib/ui.svelte';

  const PAGE_SIZE = 15;

  type SourceFilter = 'all' | 'manual' | 'scheduler';
  type StatusFilter = 'all' | 'done' | 'failed';

  let entries = $state<JobHistoryEntry[]>([]);
  let total = $state(0);
  let loaded = $state(false);
  let loadingMore = $state(false);
  let seenIds = new Set<string>();
  let requeueing = $state<Set<string>>(new Set());
  let searchText = $state('');
  let activeQuery = $state('');
  let sourceFilter = $state<SourceFilter>('all');
  let statusFilter = $state<StatusFilter>('all');
  let selected = $state<Set<string>>(new Set());
  let bulkRequeueing = $state(false);

  function matchesFilters(h: JobHistoryEntry): boolean {
    return (
      (!activeQuery || h.bundleId.toLowerCase().includes(activeQuery.toLowerCase())) &&
      (sourceFilter === 'all' || h.source === sourceFilter) &&
      (statusFilter === 'all' || h.status === statusFilter)
    );
  }

  async function loadInitial(query: string): Promise<void> {
    loaded = false;
    selected = new Set();
    const data = await fetchJobHistory(
      0,
      PAGE_SIZE,
      query || undefined,
      sourceFilter === 'all' ? undefined : sourceFilter,
      statusFilter === 'all' ? undefined : statusFilter,
    );
    entries = data.history;
    total = data.total;
    seenIds = new Set(entries.map((e) => e.id));
    loaded = true;
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    try {
      const data = await fetchJobHistory(
        entries.length,
        PAGE_SIZE,
        activeQuery || undefined,
        sourceFilter === 'all' ? undefined : sourceFilter,
        statusFilter === 'all' ? undefined : statusFilter,
      );
      const additions = data.history.filter((e) => !seenIds.has(e.id));
      for (const e of additions) seenIds.add(e.id);
      entries = [...entries, ...additions];
      total = data.total;
    } finally {
      loadingMore = false;
    }
  }

  const debouncedSearch = debounce((query: string) => {
    activeQuery = query;
    void loadInitial(query);
  }, 300);

  $effect(() => {
    if (historyJumpState.bundleId) {
      searchText = historyJumpState.bundleId;
      sourceFilter = 'all';
      statusFilter = 'all';
      historyJumpState.bundleId = null;
    }
  });

  let hasSearched = false;

  $effect(() => {
    const query = searchText.trim();
    sourceFilter;
    statusFilter;
    if (!hasSearched) {
      hasSearched = true;
      activeQuery = query;
      void loadInitial(query);
    } else {
      debouncedSearch(query);
    }
  });

  function clearSearch(): void {
    searchText = '';
  }

  $effect(() => {
    for (const h of liveState.historyAdditions) {
      if (!seenIds.has(h.id) && matchesFilters(h)) {
        entries = [h, ...entries];
        seenIds.add(h.id);
        total += 1;
      }
    }
  });

  let shareOpen = $state(false);
  let shareJobId = $state('');

  function openShare(id: string): void {
    shareJobId = id;
    shareOpen = true;
  }

  let statsOpen = $state(false);
  let statsBundleId = $state('');

  function openStats(bundleId: string): void {
    statsBundleId = bundleId;
    statsOpen = true;
  }

  async function decryptAgain(entry: JobHistoryEntry): Promise<void> {
    const { bundleId, testflight, externalVersionId, versionLabel } = entry;
    requeueing = new Set(requeueing).add(entry.id);
    try {
      const { ok, data } = testflight
        ? await queueTestFlightDecrypt(bundleId, testflight.appId, testflight.build)
        : await queueDecrypt(bundleId, externalVersionId, versionLabel);
      if (!ok) return;
      addDecrypt({ id: data.id, bundleId, trackName: bundleId, versionLabel, status: data.status, progress: data.progress, queue: data.queue });
      pushRecentBundleId(bundleId);
      showToast(`Queued ${bundleId}${versionLabel ? ` (${versionLabel})` : ''}`, 'success');
    } finally {
      const next = new Set(requeueing);
      next.delete(entry.id);
      requeueing = next;
    }
  }

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleSelectAll(): void {
    selected = selected.size === entries.length ? new Set() : new Set(entries.map((e) => e.id));
  }

  async function bulkDecryptAgain(): Promise<void> {
    const targets = entries.filter((e) => selected.has(e.id));
    if (targets.length === 0) return;
    if (!(await confirmDialog(`Queue ${targets.length} decrypt(s) again?`))) return;
    bulkRequeueing = true;
    try {
      for (const entry of targets) await decryptAgain(entry);
      selected = new Set();
    } finally {
      bulkRequeueing = false;
    }
  }

  function bulkExportCsv(): void {
    const targets = entries.filter((e) => selected.has(e.id));
    const rows = ['bundleId,version,source,queuedBy,status,size,finishedAt,error'];
    for (const j of targets) {
      rows.push(
        [j.bundleId, j.versionLabel ?? '', j.source, j.queuedBy ?? '', j.status, j.sizeBytes ?? '', new Date(j.finishedAt).toISOString(), j.error ?? '']
          .map(csvCell)
          .join(','),
      );
    }
    downloadBlob(rows.join('\n'), 'dkrypt-job-history-selected.csv', 'text/csv');
  }

  function bulkExportJson(): void {
    const targets = entries.filter((e) => selected.has(e.id));
    downloadBlob(JSON.stringify(targets, null, 2), 'dkrypt-job-history-selected.json', 'application/json');
  }

  function dayLabel(ms: number): string {
    const d = new Date(ms);
    const today = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diffDays = Math.round((startOfDay(today) - startOfDay(d)) / 86_400_000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: d.getFullYear() !== today.getFullYear() ? 'numeric' : undefined,
    });
  }

  const grouped = $derived.by((): { label: string; items: JobHistoryEntry[] }[] => {
    const groups: { label: string; items: JobHistoryEntry[] }[] = [];
    for (const e of entries) {
      const label = dayLabel(e.finishedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(e);
      else groups.push({ label, items: [e] });
    }
    return groups;
  });
</script>

<Card title="Job history">
  {#snippet headerExtra()}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if selected.size > 0}
        <Button size="sm" loading={bulkRequeueing} onclick={bulkDecryptAgain}>Decrypt {selected.size} again</Button>
        <Button size="sm" variant="secondary" onclick={bulkExportCsv}>Export {selected.size} CSV</Button>
        <Button size="sm" variant="secondary" onclick={bulkExportJson}>Export {selected.size} JSON</Button>
      {/if}
      <a href={jobHistoryExportUrl('csv')} download class={buttonVariants('secondary', 'sm')}>Export CSV</a>
      <a href={jobHistoryExportUrl('json')} download class={buttonVariants('secondary', 'sm')}>Export JSON</a>
    </div>
  {/snippet}
  <div class="mb-3 flex flex-wrap items-center gap-2.5">
    <div class="relative max-w-xs flex-1">
      <Input placeholder="Search by bundle ID…" bind:value={searchText} class="pr-8" />
      {#if searchText}
        <button
          class="text-muted hover:text-text absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer"
          onclick={clearSearch}
          aria-label="Clear search"
          title="Clear search"
        >
          <X class="h-3.5 w-3.5" />
        </button>
      {/if}
    </div>
    <div class="flex flex-wrap gap-1">
      <Button variant={statusFilter === 'all' ? 'default' : 'secondary'} onclick={() => (statusFilter = 'all')}>All</Button>
      <Button variant={statusFilter === 'done' ? 'default' : 'secondary'} onclick={() => (statusFilter = 'done')}>Done</Button>
      <Button variant={statusFilter === 'failed' ? 'default' : 'secondary'} onclick={() => (statusFilter = 'failed')}>Failed</Button>
    </div>
    <div class="flex flex-wrap gap-1">
      <Button variant={sourceFilter === 'all' ? 'default' : 'secondary'} onclick={() => (sourceFilter = 'all')}>Any source</Button>
      <Button variant={sourceFilter === 'manual' ? 'default' : 'secondary'} onclick={() => (sourceFilter = 'manual')}>Manual</Button>
      <Button variant={sourceFilter === 'scheduler' ? 'default' : 'secondary'} onclick={() => (sourceFilter = 'scheduler')}>
        Scheduler
      </Button>
    </div>
  </div>

  {#if loaded && entries.length === 0}
    <EmptyState
      icon={History}
      message={activeQuery || sourceFilter !== 'all' || statusFilter !== 'all' ? 'No decrypts match these filters.' : 'No decrypts yet.'}
    />
  {:else}
    <div class="scroll-fade-x max-h-[600px] overflow-auto" use:scrollFade>
      <table class="responsive-table sm:min-w-[720px]">
        <thead>
          <tr>
            <th><input type="checkbox" checked={entries.length > 0 && selected.size === entries.length} onchange={toggleSelectAll} /></th>
            <th>Bundle ID</th>
            <th>Version</th>
            <th>Source</th>
            <th>Queued by</th>
            <th>Status</th>
            <th>Size</th>
            <th>Finished</th>
            <th>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#if !loaded}
            <SkeletonRows rows={4} colspan={10} />
          {:else}
            {#each grouped as g (g.label)}
              <tr class="table-row-header bg-panel sticky top-0 z-10">
                <td colspan="10" class="border-b-0! py-1.5 text-xs font-semibold text-muted">{g.label}</td>
              </tr>
              {#each g.items as j (j.id)}
                <tr>
                  <td data-label="Select"><input type="checkbox" checked={selected.has(j.id)} onchange={() => toggleSelect(j.id)} /></td>
                  <td data-label="Bundle ID" class="max-w-40">
                    <button
                      class="block max-w-full truncate cursor-pointer text-left hover:text-accent hover:underline"
                      title="View stats for {j.bundleId}"
                      onclick={() => openStats(j.bundleId)}
                    >
                      {j.bundleId}
                    </button>
                  </td>
                  <td data-label="Version" class="max-w-36">
                    <div class="flex min-w-0 items-center gap-1" title={j.versionLabel ?? ''}>
                      <span class="truncate">
                        {#if j.versionLabel}
                          {j.versionLabel}
                        {:else}
                          <span class="text-muted">-</span>
                        {/if}
                      </span>
                      {#if j.testflight}
                        <Badge variant="secondary" class="shrink-0">TF</Badge>
                      {:else if j.externalVersionId}
                        <Badge variant="secondary" class="shrink-0" title="pinned to external version id {j.externalVersionId}">pinned</Badge>
                      {/if}
                    </div>
                  </td>
                  <td data-label="Source">{j.source}</td>
                  <td data-label="Queued by" class="text-muted">{j.queuedBy ?? '-'}</td>
                  <td data-label="Status"><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
                  <td data-label="Size">{fmtSize(j.sizeBytes)}</td>
                  <td data-label="Finished" class="text-muted"><RelativeTime ms={j.finishedAt} /></td>
                  <td data-label="Error" class="max-w-52 truncate text-muted" title={j.error ?? ''}>{j.error ?? ''}</td>
                  <td>
                    <div class="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="secondary" loading={requeueing.has(j.id)} onclick={() => decryptAgain(j)}>
                        Decrypt again
                      </Button>
                      {#if j.status === 'done'}
                        <Button size="sm" variant="secondary" onclick={() => openShare(j.id)}>Share</Button>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            {/each}
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
  {#if loaded && entries.length < total}
    <div class="mt-3 flex justify-center">
      <Button size="sm" variant="secondary" loading={loadingMore} onclick={loadMore}>
        Load more ({total - entries.length} older)
      </Button>
    </div>
  {/if}
</Card>

<ShareLinkDialog open={shareOpen} jobId={shareJobId} onOpenChange={(v) => (shareOpen = v)} />
<BundleStatsDialog open={statsOpen} bundleId={statsBundleId} onOpenChange={(v) => (statsOpen = v)} />
