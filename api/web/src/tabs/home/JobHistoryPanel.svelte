<script lang="ts">
  import { History, X } from 'lucide-svelte';
  import BundleStatsDialog from '#components/BundleStatsDialog.svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import ShareLinkDialog from '#components/ShareLinkDialog.svelte';
  import {
    fetchJobHistory,
    fetchJobTimeline,
    jobHistoryExportUrl,
    queueDecrypt,
    queueTestFlightDecrypt,
    retryJob,
    type JobHistoryEntry,
    type JobTimeline,
  } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { buttonVariants, statusToBadgeVariant } from '#lib/components/ui/variants';
  import { addDecrypt, pushRecentBundleId } from '#lib/decrypts.svelte';
  import { csvCell, debounce, downloadBlob, fmtSize } from '#lib/format';
  import { liveState } from '#lib/live.svelte';
  import { createSavedViews } from '#lib/savedViews.svelte';
  import { sessionState } from '#lib/session.svelte';
  import { confirmDialog, historyJumpState, requestFocusSearch, showToast, tabState } from '#lib/ui.svelte';
  import { getQueryParam, setQueryParams } from '#lib/urlState';

  const PAGE_SIZE = 15;

  type SourceFilter = 'all' | 'manual' | 'scheduler';
  type StatusFilter = 'all' | 'done' | 'failed';

  interface FilterPreset {
    name: string;
    query: string;
    source: SourceFilter;
    status: StatusFilter;
    queuedBy: string;
    deviceId: string;
    errorQ: string;
    failureCategory: string;
  }

  const CANCELLED_RE = /^cancelled by/i;
  const TIMEOUT_RE = /timed? ?out/i;
  const UNREACHABLE_RE = /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|no route to host|not reachable|connection closed/i;
  const DISK_RE = /ENOSPC|no space left/i;

  function categorizeFailure(message: string | undefined): string {
    if (!message) return 'Unknown';
    if (CANCELLED_RE.test(message)) return 'Cancelled';
    if (UNREACHABLE_RE.test(message)) return 'Device unreachable';
    if (DISK_RE.test(message)) return 'Disk full';
    if (TIMEOUT_RE.test(message)) return 'Timed out';
    return 'Other';
  }

  let entries = $state<JobHistoryEntry[]>([]);
  let total = $state(0);
  let loaded = $state(false);
  let loadingMore = $state(false);
  let seenIds = new Set<string>();
  let requeueing = $state<Set<string>>(new Set());
  let searchText = $state(getQueryParam('hq') ?? localStorage.getItem('jobHistorySearchText') ?? '');
  let activeQuery = $state('');
  let sourceFilter = $state<SourceFilter>((getQueryParam('hsource') as SourceFilter | undefined) ?? (localStorage.getItem('jobHistorySourceFilter') as SourceFilter | null) ?? 'all');
  let statusFilter = $state<StatusFilter>((getQueryParam('hstatus') as StatusFilter | undefined) ?? (localStorage.getItem('jobHistoryStatusFilter') as StatusFilter | null) ?? 'all');
  let queuedByFilter = $state(getQueryParam('hqueuedBy') ?? localStorage.getItem('jobHistoryQueuedByFilter') ?? '');
  let deviceFilter = $state(getQueryParam('hdevice') ?? localStorage.getItem('jobHistoryDeviceFilter') ?? '');
  let errorFilter = $state(getQueryParam('herror') ?? localStorage.getItem('jobHistoryErrorFilter') ?? '');
  let failureCategoryFilter = $state(getQueryParam('hcat') ?? localStorage.getItem('jobHistoryFailureCategoryFilter') ?? '');
  let selected = $state<Set<string>>(new Set());
  let bulkRequeueing = $state(false);
  const savedViews = createSavedViews<FilterPreset>('jobHistoryFilterPresets');
  let newPresetName = $state('');
  let timelineById = $state<Record<string, JobTimeline>>({});
  let timelineOpenId = $state<string | null>(null);
  let timelineLoading = $state<Set<string>>(new Set());

  function applyPreset(p: FilterPreset): void {
    searchText = p.query;
    sourceFilter = p.source;
    statusFilter = p.status;
    queuedByFilter = p.queuedBy;
    deviceFilter = p.deviceId;
    errorFilter = p.errorQ;
    failureCategoryFilter = p.failureCategory ?? '';
  }

  function savePreset(): void {
    const name = newPresetName.trim();
    if (!name) return;
    savedViews.save({
      name,
      query: searchText.trim(),
      source: sourceFilter,
      status: statusFilter,
      queuedBy: queuedByFilter.trim(),
      deviceId: deviceFilter.trim(),
      errorQ: errorFilter.trim(),
      failureCategory: failureCategoryFilter.trim(),
    });
    newPresetName = '';
  }

  function removePreset(name: string): void {
    savedViews.remove(name);
  }

  $effect(() => {
    if (tabState.active !== 'home') return;
    setQueryParams({
      hq: searchText.trim() || undefined,
      hsource: sourceFilter === 'all' ? undefined : sourceFilter,
      hstatus: statusFilter === 'all' ? undefined : statusFilter,
      hqueuedBy: queuedByFilter.trim() || undefined,
      hdevice: deviceFilter.trim() || undefined,
      herror: errorFilter.trim() || undefined,
      hcat: failureCategoryFilter.trim() || undefined,
    });
  });

  function matchesFilters(h: JobHistoryEntry): boolean {
    return (
      (!activeQuery || h.bundleId.toLowerCase().includes(activeQuery.toLowerCase())) &&
      (sourceFilter === 'all' || h.source === sourceFilter) &&
      (statusFilter === 'all' || h.status === statusFilter) &&
      (!queuedByFilter.trim() || (h.queuedBy ?? '').toLowerCase().includes(queuedByFilter.trim().toLowerCase())) &&
      (!deviceFilter.trim() || (h.deviceId ?? '').toLowerCase().includes(deviceFilter.trim().toLowerCase())) &&
      (!errorFilter.trim() || (h.error ?? '').toLowerCase().includes(errorFilter.trim().toLowerCase())) &&
      (!failureCategoryFilter.trim() || (h.status === 'failed' && categorizeFailure(h.error) === failureCategoryFilter.trim()))
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
      {
        queuedBy: queuedByFilter.trim() || undefined,
        deviceId: deviceFilter.trim() || undefined,
        errorQ: errorFilter.trim() || undefined,
        failureCategory: failureCategoryFilter.trim() || undefined,
      },
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
        {
          queuedBy: queuedByFilter.trim() || undefined,
          deviceId: deviceFilter.trim() || undefined,
          errorQ: errorFilter.trim() || undefined,
          failureCategory: failureCategoryFilter.trim() || undefined,
        },
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

  $effect(() => {
    if (historyJumpState.failureCategory) {
      failureCategoryFilter = historyJumpState.failureCategory;
      statusFilter = 'failed';
      historyJumpState.failureCategory = null;
    }
  });

  let hasSearched = false;

  $effect(() => {
    const query = searchText.trim();
    sourceFilter;
    statusFilter;
    queuedByFilter;
    deviceFilter;
    errorFilter;
    failureCategoryFilter;
    if (!hasSearched) {
      hasSearched = true;
      activeQuery = query;
      void loadInitial(query);
    } else {
      debouncedSearch(query);
    }
  });

  $effect(() => {
    localStorage.setItem('jobHistorySearchText', searchText);
  });
  $effect(() => {
    localStorage.setItem('jobHistorySourceFilter', sourceFilter);
  });
  $effect(() => {
    localStorage.setItem('jobHistoryStatusFilter', statusFilter);
  });
  $effect(() => {
    localStorage.setItem('jobHistoryQueuedByFilter', queuedByFilter);
  });
  $effect(() => {
    localStorage.setItem('jobHistoryDeviceFilter', deviceFilter);
  });
  $effect(() => {
    localStorage.setItem('jobHistoryErrorFilter', errorFilter);
  });
  $effect(() => {
    localStorage.setItem('jobHistoryFailureCategoryFilter', failureCategoryFilter);
  });

  function clearSearch(): void {
    searchText = '';
  }

  const hasActiveFilters = $derived(
    !!(activeQuery || sourceFilter !== 'all' || statusFilter !== 'all' || queuedByFilter || deviceFilter || errorFilter || failureCategoryFilter),
  );
  const advancedFilterCount = $derived([queuedByFilter, deviceFilter, errorFilter, failureCategoryFilter].filter((value) => value.trim()).length);

  function clearAllFilters(): void {
    searchText = '';
    sourceFilter = 'all';
    statusFilter = 'all';
    queuedByFilter = '';
    deviceFilter = '';
    errorFilter = '';
    failureCategoryFilter = '';
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
  let statsPreselectIds = $state<string[] | undefined>(undefined);

  function openStats(bundleId: string): void {
    statsBundleId = bundleId;
    statsPreselectIds = undefined;
    statsOpen = true;
  }

  const compareCandidate = $derived.by(() => {
    if (selected.size !== 2) return null;
    const rows = entries.filter((e) => selected.has(e.id));
    if (rows.length !== 2 || rows[0].bundleId !== rows[1].bundleId || rows.some((r) => r.status !== 'done')) return null;
    return { bundleId: rows[0].bundleId, ids: rows.map((r) => r.id) };
  });

  function openCompare(): void {
    if (!compareCandidate) return;
    statsBundleId = compareCandidate.bundleId;
    statsPreselectIds = compareCandidate.ids;
    statsOpen = true;
  }

  function curlFor(entry: JobHistoryEntry): string {
    const base = sessionState.publicBaseUrl ?? location.origin;
    const versionQuery = entry.externalVersionId ? `&externalVersionId=${entry.externalVersionId}` : '';
    return `curl -H "Authorization: Bearer <YOUR_API_KEY>" "${base}/v1/decrypt?bundleId=${entry.bundleId}${versionQuery}" -o ${entry.bundleId}.ipa`;
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

  async function retryOnPrimary(entry: JobHistoryEntry): Promise<void> {
    requeueing = new Set(requeueing).add(entry.id);
    try {
      const { ok, data } = await retryJob(entry.id, true);
      if (!ok) return;
      addDecrypt({
        id: data.id,
        bundleId: entry.bundleId,
        trackName: entry.bundleId,
        versionLabel: entry.versionLabel,
        externalVersionId: entry.externalVersionId,
        testflight: entry.testflight,
        status: data.status,
        progress: data.progress,
        queue: data.queue,
      });
      pushRecentBundleId(entry.bundleId);
      showToast(`Retried ${entry.bundleId} on primary device`, 'success');
    } finally {
      const next = new Set(requeueing);
      next.delete(entry.id);
      requeueing = next;
    }
  }

  async function toggleTimeline(jobId: string): Promise<void> {
    if (timelineOpenId === jobId) {
      timelineOpenId = null;
      return;
    }
    timelineOpenId = jobId;
    if (timelineById[jobId]) return;
    const next = new Set(timelineLoading);
    next.add(jobId);
    timelineLoading = next;
    try {
      timelineById = { ...timelineById, [jobId]: await fetchJobTimeline(jobId) };
    } finally {
      const done = new Set(timelineLoading);
      done.delete(jobId);
      timelineLoading = done;
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

{#snippet jobActionControls(entry: JobHistoryEntry)}
  {#if entry.status === 'done'}
    <Button size="sm" variant="secondary" onclick={() => openShare(entry.id)}>Share</Button>
  {/if}
  {#if !entry.testflight}
    <CopyButton text={curlFor(entry)} label="curl" />
  {/if}
{/snippet}

<Card title="Job history" id="job-history">
  {#snippet headerExtra()}
    <div class="flex flex-wrap items-center gap-1.5">
      {#if selected.size > 0}
        {#if compareCandidate}
          <Button size="sm" variant="secondary" onclick={openCompare}>Compare selected</Button>
        {/if}
        <Button size="sm" loading={bulkRequeueing} onclick={bulkDecryptAgain}>Decrypt {selected.size} again</Button>
        <Button size="sm" variant="secondary" onclick={bulkExportCsv}>Export {selected.size} CSV</Button>
        <Button size="sm" variant="secondary" onclick={bulkExportJson}>Export {selected.size} JSON</Button>
      {:else if entries.length > 0}
        <Button size="sm" variant="secondary" onclick={toggleSelectAll}>Select loaded</Button>
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

  <details class="border-border mb-3 rounded-lg border">
    <summary class="text-muted cursor-pointer px-3 py-2 text-xs font-medium">
      More filters and saved views{advancedFilterCount ? ` · ${advancedFilterCount} active` : ''}
    </summary>
    <div class="border-border grid grid-cols-1 gap-2 border-t p-3 sm:grid-cols-3">
      <Input placeholder="Queued by username…" bind:value={queuedByFilter} />
      <Input placeholder="Device id…" bind:value={deviceFilter} />
      <Input placeholder="Error contains…" bind:value={errorFilter} />
    </div>
    <div class="border-border flex flex-wrap items-center gap-1.5 border-t p-3">
      {#if failureCategoryFilter}
        <span class="border-accent text-accent inline-flex items-center gap-1.5 rounded-full border pr-1 pl-2.5 py-1 text-[12px]">
          Failure category: {failureCategoryFilter}
          <button
            class="hover:text-err cursor-pointer rounded-full p-0.5"
            onclick={() => (failureCategoryFilter = '')}
            aria-label="Clear failure category filter"
            title="Clear failure category filter"
          >
            <X class="h-3 w-3" />
          </button>
        </span>
      {/if}
      {#each savedViews.presets as p (p.name)}
        <span class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 text-[12px]">
          <button class="cursor-pointer" onclick={() => applyPreset(p)}>{p.name}</button>
          <button
            class="text-muted hover:text-err cursor-pointer rounded-full p-0.5"
            onclick={() => removePreset(p.name)}
            aria-label="Delete preset {p.name}"
            title="Delete preset"
          >
            <X class="h-3 w-3" />
          </button>
        </span>
      {/each}
      <div class="flex items-center gap-1.5">
        <Input placeholder="Preset name…" bind:value={newPresetName} class="h-7 w-32 text-xs" />
        <Button size="sm" variant="secondary" disabled={!newPresetName.trim()} onclick={savePreset}>Save view</Button>
      </div>
    </div>
  </details>

  {#if loaded && entries.length === 0}
    <EmptyState icon={History} message={hasActiveFilters ? 'No decrypts match these filters.' : 'No decrypts yet.'}>
      {#snippet action()}
        {#if hasActiveFilters}
          <Button size="sm" variant="secondary" onclick={clearAllFilters}>Clear filters</Button>
        {:else}
          <Button size="sm" variant="secondary" onclick={requestFocusSearch}>Queue a decrypt</Button>
        {/if}
      {/snippet}
    </EmptyState>
  {:else}
    <div class="history-feed">
      {#if !loaded}
        {#each Array(5) as _, i (i)}
          <div class="skeleton border-border h-20 border-b" aria-label="Loading job history"></div>
        {/each}
      {:else}
        {#each grouped as g (g.label)}
          <section class="mb-5">
            <div class="border-border mb-1 flex items-center gap-2 border-b pb-2">
              <span class="text-[11px] font-semibold tracking-[0.12em] text-muted uppercase">{g.label}</span>
              <span class="text-[11px] text-muted">{g.items.length} job{g.items.length === 1 ? '' : 's'}</span>
            </div>
            <div role="list">
              {#each g.items as j (j.id)}
                <article class="history-feed-row" role="listitem">
                  <div class="flex min-w-0 flex-1 items-start gap-3">
                    <input class="mt-1" type="checkbox" checked={selected.has(j.id)} onchange={() => toggleSelect(j.id)} aria-label="Select {j.bundleId}" />
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <button
                          class="max-w-full cursor-pointer truncate font-mono text-[12px] font-medium hover:text-accent hover:underline"
                          title="View stats for {j.bundleId}"
                          onclick={() => openStats(j.bundleId)}
                        >
                          {j.bundleId}
                        </button>
                        {#if j.testflight}
                          <Badge variant="secondary">TestFlight</Badge>
                        {/if}
                        <span class="text-xs text-muted">{j.source}</span>
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        <span>{j.versionLabel ?? 'Unspecified version'}</span>
                        <span>{fmtSize(j.sizeBytes)}</span>
                        <span>by {j.queuedBy ?? 'unknown'}</span>
                      </div>
                    </div>
                  </div>
                  <div class="min-w-[12rem] flex-1">
                    <div class="flex items-center gap-2">
                      <Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge>
                      <span class="text-xs text-muted"><RelativeTime ms={j.finishedAt} /></span>
                    </div>
                    {#if j.error}
                      <p class="mt-1 line-clamp-2 text-xs leading-5 text-muted" title={j.error}>{j.error}</p>
                    {/if}
                  </div>
                  <div class="flex shrink-0 items-center gap-1.5">
                    {#if j.status === 'failed'}
                      <Button size="sm" loading={requeueing.has(j.id)} onclick={() => retryOnPrimary(j)}>Retry</Button>
                    {:else}
                      <Button size="sm" variant="secondary" loading={requeueing.has(j.id)} onclick={() => decryptAgain(j)}>Decrypt again</Button>
                    {/if}
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={timelineLoading.has(j.id)}
                      onclick={() => toggleTimeline(j.id)}
                      aria-expanded={timelineOpenId === j.id}
                    >
                      {timelineOpenId === j.id ? 'Close' : 'Details'}
                    </Button>
                  </div>
                  {#if timelineOpenId === j.id}
                    <div class="history-feed-detail">
                      <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
                        <div>
                          <div class="mb-2 text-[11px] font-semibold tracking-[0.1em] text-muted uppercase">Activity</div>
                          {#if timelineById[j.id]}
                            <ol class="flex flex-wrap gap-2">
                              {#each timelineById[j.id].events as ev (ev.at + ev.label)}
                                <li class="border-border inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                                  <Badge variant={statusToBadgeVariant(ev.status)}>{ev.status}</Badge>
                                  <span>{ev.label}</span>
                                  <span class="text-muted"><RelativeTime ms={ev.at} /></span>
                                </li>
                              {/each}
                            </ol>
                          {:else}
                            <div class="text-xs text-muted">Loading activity…</div>
                          {/if}
                        </div>
                        <div class="flex flex-wrap items-start gap-1.5">
                          {@render jobActionControls(j)}
                        </div>
                      </div>
                    </div>
                  {/if}
                </article>
              {/each}
            </div>
          </section>
        {/each}
      {/if}
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
<BundleStatsDialog open={statsOpen} bundleId={statsBundleId} preselectIds={statsPreselectIds} onOpenChange={(v) => (statsOpen = v)} />
