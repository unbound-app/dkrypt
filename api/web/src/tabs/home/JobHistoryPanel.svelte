<script lang="ts">
  import RelativeTime from '../../components/RelativeTime.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { fetchJobHistory, queueDecrypt, type JobHistoryEntry } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { addDecrypt, pushRecentBundleId } from '../../lib/decrypts.svelte';
  import { fmtSize } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { showToast } from '../../lib/ui.svelte';

  const PAGE_SIZE = 15;

  let entries = $state<JobHistoryEntry[]>([]);
  let total = $state(0);
  let loaded = $state(false);
  let loadingMore = $state(false);
  let seenIds = new Set<string>();

  async function loadInitial(): Promise<void> {
    const data = await fetchJobHistory(0, PAGE_SIZE);
    entries = data.history;
    total = data.total;
    seenIds = new Set(entries.map((e) => e.id));
    loaded = true;
  }

  async function loadMore(): Promise<void> {
    loadingMore = true;
    try {
      const data = await fetchJobHistory(entries.length, PAGE_SIZE);
      const additions = data.history.filter((e) => !seenIds.has(e.id));
      for (const e of additions) seenIds.add(e.id);
      entries = [...entries, ...additions];
      total = data.total;
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    void loadInitial();
  });

  $effect(() => {
    for (const h of liveState.historyAdditions) {
      if (!seenIds.has(h.id)) {
        entries = [h, ...entries];
        seenIds.add(h.id);
        total += 1;
      }
    }
  });

  async function decryptAgain(bundleId: string): Promise<void> {
    const { ok, data } = await queueDecrypt(bundleId);
    if (!ok) return;
    addDecrypt({ id: data.id, bundleId, trackName: bundleId, status: data.status, progress: data.progress, queue: data.queue });
    pushRecentBundleId(bundleId);
    showToast(`Queued ${bundleId}`, 'success');
  }
</script>

<Card title="Job history">
  <div class="overflow-x-auto">
    <table class="min-w-[640px]">
      <thead>
        <tr>
          <th>Bundle ID</th>
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
          <SkeletonRows rows={4} colspan={7} />
        {:else}
          {#each entries as j (j.id)}
            <tr>
              <td class="max-w-40 truncate" title={j.bundleId}>{j.bundleId}</td>
              <td>{j.source}</td>
              <td><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
              <td>{fmtSize(j.sizeBytes)}</td>
              <td class="text-muted"><RelativeTime ms={j.finishedAt} /></td>
              <td class="max-w-52 truncate text-muted" title={j.error ?? ''}>{j.error ?? ''}</td>
              <td><Button size="sm" variant="secondary" onclick={() => decryptAgain(j.bundleId)}>Decrypt again</Button></td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  {#if loaded && entries.length < total}
    <div class="mt-3 flex justify-center">
      <Button size="sm" variant="secondary" disabled={loadingMore} onclick={loadMore}>
        Load more ({total - entries.length} older)
      </Button>
    </div>
  {/if}
</Card>
