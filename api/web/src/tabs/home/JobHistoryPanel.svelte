<script lang="ts">
  import { History, X } from 'lucide-svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { fetchJobHistory, queueDecrypt, queueTestFlightDecrypt, type JobHistoryEntry } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { addDecrypt, pushRecentBundleId } from '../../lib/decrypts.svelte';
  import { debounce, fmtSize } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { scrollFade } from '../../lib/scrollFade';
  import { showToast } from '../../lib/ui.svelte';

  const PAGE_SIZE = 15;

  let entries = $state<JobHistoryEntry[]>([]);
  let total = $state(0);
  let loaded = $state(false);
  let loadingMore = $state(false);
  let seenIds = new Set<string>();
  let requeueing = $state<Set<string>>(new Set());
  let searchText = $state('');
  let activeQuery = $state('');

  async function loadInitial(query: string): Promise<void> {
    loaded = false;
    const data = await fetchJobHistory(0, PAGE_SIZE, query || undefined);
    entries = data.history;
    total = data.total;
    seenIds = new Set(entries.map((e) => e.id));
    loaded = true;
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    try {
      const data = await fetchJobHistory(entries.length, PAGE_SIZE, activeQuery || undefined);
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

  let hasSearched = false;

  $effect(() => {
    const query = searchText.trim();
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
      if (!seenIds.has(h.id) && (!activeQuery || h.bundleId.toLowerCase().includes(activeQuery.toLowerCase()))) {
        entries = [h, ...entries];
        seenIds.add(h.id);
        total += 1;
      }
    }
  });

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
  <div class="relative mb-3.5 max-w-xs">
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

  {#if loaded && entries.length === 0}
    <EmptyState icon={History} message={activeQuery ? `No decrypts match "${activeQuery}".` : 'No decrypts yet.'} />
  {:else}
    <div class="scroll-fade-x max-h-[600px] overflow-auto" use:scrollFade>
      <table class="min-w-[640px]">
        <thead>
          <tr>
            <th>Bundle ID</th>
            <th>Version</th>
            <th>Source</th>
            <th>Status</th>
            <th>Size</th>
            <th>Finished</th>
            <th>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#if !loaded}
            <SkeletonRows rows={4} colspan={8} />
          {:else}
            {#each grouped as g (g.label)}
              <tr class="bg-panel sticky top-0 z-10">
                <td colspan="8" class="border-b-0! py-1.5 text-xs font-semibold text-muted">{g.label}</td>
              </tr>
              {#each g.items as j (j.id)}
                <tr>
                  <td class="max-w-40 truncate" title={j.bundleId}>{j.bundleId}</td>
                  <td class="max-w-36 truncate" title={j.versionLabel ?? ''}>
                    {#if j.versionLabel}
                      {j.versionLabel}
                    {:else}
                      <span class="text-muted">-</span>
                    {/if}
                    {#if j.testflight}
                      <Badge variant="secondary" class="ml-1">TF</Badge>
                    {:else if j.externalVersionId}
                      <Badge variant="secondary" class="ml-1" title="pinned to external version id {j.externalVersionId}">pinned</Badge>
                    {/if}
                  </td>
                  <td>{j.source}</td>
                  <td><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
                  <td>{fmtSize(j.sizeBytes)}</td>
                  <td class="text-muted"><RelativeTime ms={j.finishedAt} /></td>
                  <td class="max-w-52 truncate text-muted" title={j.error ?? ''}>{j.error ?? ''}</td>
                  <td>
                    <Button size="sm" variant="secondary" loading={requeueing.has(j.id)} onclick={() => decryptAgain(j)}>
                      Decrypt again
                    </Button>
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
