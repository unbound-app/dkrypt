<script lang="ts">
  import { Search } from 'lucide-svelte';
  import { queueDecrypt, searchApps, type AppStoreSearchResult } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { addDecrypt, myDecryptsState, pushRecentBundleId, recentBundleIdsState } from '../../lib/decrypts.svelte';
  import { debounce } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { showToast } from '../../lib/ui.svelte';
  import { cn } from '../../lib/utils';

  let term = $state('');
  let results = $state<AppStoreSearchResult[]>([]);
  let loading = $state(false);
  let searched = $state(false);
  let highlighted = $state(-1);
  let inputEl: HTMLInputElement | undefined = $state();

  const statusByBundle = $derived.by(() => {
    const map = new Map<string, string>();
    for (const d of myDecryptsState.items) map.set(d.bundleId, d.status);
    for (const j of liveState.overview?.activeJobs ?? []) if (!map.has(j.bundleId)) map.set(j.bundleId, j.status);
    return map;
  });

  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim();
    if (!trimmed) {
      results = [];
      searched = false;
      return;
    }
    loading = true;
    try {
      const data = await searchApps(trimmed);
      if ('error' in data) {
        showToast(data.error, 'error');
        results = [];
      } else {
        results = data.results;
      }
      searched = true;
      highlighted = -1;
    } finally {
      loading = false;
    }
  }

  const debouncedSearch = debounce((q: string) => void runSearch(q), 400);

  function onInput(): void {
    if (!term.trim()) {
      results = [];
      searched = false;
      return;
    }
    debouncedSearch(term);
  }

  async function queue(bundleId: string, trackName: string): Promise<void> {
    const { ok, data } = await queueDecrypt(bundleId);
    if (!ok) return;
    addDecrypt({ id: data.id, bundleId, trackName, status: data.status, progress: data.progress, queue: data.queue });
    pushRecentBundleId(bundleId);
    showToast(`Queued ${trackName}`, 'success');
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = highlighted >= 0 ? results[highlighted] : undefined;
      if (target && target.price === 0) void queue(target.bundleId, target.trackName);
      else void runSearch(term);
    } else if (e.key === 'ArrowDown' && results.length > 0) {
      e.preventDefault();
      highlighted = Math.min(highlighted + 1, results.length - 1);
    } else if (e.key === 'ArrowUp' && results.length > 0) {
      e.preventDefault();
      highlighted = Math.max(highlighted - 1, -1);
    }
  }

  function pickRecent(bundleId: string): void {
    term = bundleId;
    void runSearch(bundleId);
  }

  export function focusSearch(): void {
    inputEl?.focus();
  }
</script>

<Card title="Decrypt an app">
  <div class="flex gap-2">
    <Input
      bind:ref={inputEl}
      bind:value={term}
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="Search the App Store to decrypt… (press / to focus)"
    />
    <Button onclick={() => runSearch(term)}>
      <Search class="h-4 w-4" />
      Search
    </Button>
  </div>

  {#if !term.trim() && recentBundleIdsState.items.length > 0}
    <div class="mt-2.5 flex flex-wrap gap-1.5">
      {#each recentBundleIdsState.items as bundleId (bundleId)}
        <button
          class="border-border text-muted hover:text-text hover:border-accent cursor-pointer rounded-full border px-2.5 py-1 font-mono text-[11.5px]"
          onclick={() => pickRecent(bundleId)}
        >
          {bundleId}
        </button>
      {/each}
    </div>
  {/if}

  <div class="mt-3.5">
    {#if loading}
      <div class="text-sm text-muted">Searching…</div>
    {:else if searched && results.length === 0}
      <div class="text-sm text-muted">No results.</div>
    {:else}
      {#each results as r, i (r.bundleId)}
        <div class={cn('border-border flex items-center gap-3 border-t py-2.5 first:border-t-0', i === highlighted && 'bg-accent/10 rounded-lg')}>
          {#if r.artworkUrl}
            <img src={r.artworkUrl} alt="" class="h-10 w-10 shrink-0 rounded-lg" />
          {/if}
          <div class="min-w-0 flex-1">
            <div class="text-[13px]">{r.trackName}</div>
            <div class="truncate text-xs text-muted" title={r.bundleId}>{r.bundleId} · v{r.version} · {r.sellerName}</div>
          </div>
          {#if r.price > 0}
            <Badge variant="destructive" title="ipadecrypt only supports free apps">Paid</Badge>
          {:else if statusByBundle.has(r.bundleId)}
            {@const status = statusByBundle.get(r.bundleId) ?? ''}
            <Badge variant={statusToBadgeVariant(status)}>{status}</Badge>
          {:else}
            <Button size="sm" onclick={() => queue(r.bundleId, r.trackName)}>Decrypt</Button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</Card>
