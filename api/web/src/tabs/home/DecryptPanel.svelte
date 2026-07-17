<script lang="ts">
  import { FlaskConical, History, Star, X } from 'lucide-svelte';
  import { queueDecrypt, queueTestFlightDecrypt, searchApps, type AppStoreSearchResult, type TFBuild } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import {
    addDecrypt,
    isStarredBundleId,
    myDecryptsState,
    pushRecentBundleId,
    recentBundleIdsState,
    removeRecentBundleId,
    starredBundleIdsState,
    toggleStarredBundleId,
  } from '../../lib/decrypts.svelte';
  import { debounce } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { requestNotificationPermission } from '../../lib/notifications';
  import { sessionState } from '../../lib/session.svelte';
  import { showToast } from '../../lib/ui.svelte';
  import { cn } from '../../lib/utils';
  import TestFlightPickerDialog from './TestFlightPickerDialog.svelte';
  import VersionPickerDialog from './VersionPickerDialog.svelte';

  let term = $state('');
  let results = $state<AppStoreSearchResult[]>([]);
  let loading = $state(false);
  let searched = $state(false);
  let highlighted = $state(-1);
  let inputEl: HTMLInputElement | undefined = $state();
  let searchToken = 0;
  let queueing = $state<Set<string>>(new Set());

  const statusByBundle = $derived.by(() => {
    const map = new Map<string, string>();
    for (const d of myDecryptsState.items) if (!map.has(d.bundleId)) map.set(d.bundleId, d.status);
    for (const j of liveState.overview?.activeJobs ?? []) if (!map.has(j.bundleId)) map.set(j.bundleId, j.status);
    return map;
  });

  async function runSearch(q: string): Promise<void> {
    const trimmed = q.trim();
    const token = ++searchToken;
    if (!trimmed) {
      results = [];
      searched = false;
      return;
    }
    loading = true;
    try {
      const data = await searchApps(trimmed);
      if (token !== searchToken) return;
      if ('error' in data) {
        showToast(data.error, 'error');
        results = [];
      } else {
        results = data.results;
      }
      searched = true;
      highlighted = -1;
    } catch (err) {
      if (token !== searchToken) return;
      // 'network error' and 'unauthorized' are already surfaced by the fetch layer itself.
      const alreadyHandled = err instanceof Error && (err.message === 'network error' || err.message === 'unauthorized');
      if (!alreadyHandled) showToast('App Store search failed - try again', 'error');
      results = [];
      searched = true;
    } finally {
      if (token === searchToken) loading = false;
    }
  }

  const debouncedSearch = debounce((q: string) => void runSearch(q), 400);

  function onInput(): void {
    if (!term.trim()) {
      debouncedSearch.cancel();
      searchToken++;
      results = [];
      searched = false;
      loading = false;
      return;
    }
    debouncedSearch(term);
  }

  function clearSearch(): void {
    term = '';
    onInput();
    inputEl?.focus();
  }

  const canDecrypt = $derived(!!sessionState.permissions?.decrypt);

  let versionsOpen = $state(false);
  let versionsBundleId = $state('');
  let versionsTrackName = $state('');

  function openVersions(bundleId: string, trackName: string): void {
    versionsBundleId = bundleId;
    versionsTrackName = trackName;
    versionsOpen = true;
  }

  async function queue(bundleId: string, trackName: string, externalVersionId?: string, versionLabel?: string): Promise<void> {
    if (!canDecrypt) return;
    requestNotificationPermission();
    queueing = new Set(queueing).add(bundleId);
    try {
      const { ok, data } = await queueDecrypt(bundleId, externalVersionId, versionLabel);
      if (!ok) return;
      addDecrypt({ id: data.id, bundleId, trackName, versionLabel, externalVersionId, status: data.status, progress: data.progress, queue: data.queue });
      pushRecentBundleId(bundleId);
      showToast(`Queued ${trackName}${versionLabel ? ` (${versionLabel})` : ''}`, 'success');
    } finally {
      const next = new Set(queueing);
      next.delete(bundleId);
      queueing = next;
    }
  }

  function decryptVersion(bundleId: string, externalVersionId: string, label: string): void {
    versionsOpen = false;
    void queue(bundleId, versionsTrackName, externalVersionId, label);
  }

  let testflightOpen = $state(false);
  let testflightBundleId = $state('');
  let testflightAppId = $state(0);
  let testflightTrackName = $state('');

  function openTestFlight(bundleId: string, appId: number, trackName: string): void {
    testflightBundleId = bundleId;
    testflightAppId = appId;
    testflightTrackName = trackName;
    testflightOpen = true;
  }

  async function decryptTestFlightBuild(bundleId: string, appId: number, build: TFBuild, label: string): Promise<void> {
    if (!canDecrypt) return;
    requestNotificationPermission();
    testflightOpen = false;
    const { ok, data } = await queueTestFlightDecrypt(bundleId, appId, build);
    if (!ok) return;
    addDecrypt({
      id: data.id,
      bundleId,
      trackName: testflightTrackName,
      versionLabel: `TestFlight ${label}`,
      testflight: { appId, build },
      status: data.status,
      progress: data.progress,
      queue: data.queue,
    });
    pushRecentBundleId(bundleId);
    showToast(`Queued ${testflightTrackName} (TestFlight ${label})`, 'success');
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
  <div class="relative">
    <Input
      bind:ref={inputEl}
      bind:value={term}
      oninput={onInput}
      onkeydown={onKeydown}
      placeholder="Search the App Store to decrypt… (press / to focus)"
      class={term ? 'pr-8' : ''}
    />
    {#if term}
      <button
        class="text-muted hover:text-text absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer"
        onclick={clearSearch}
        aria-label="Clear search"
        title="Clear search"
      >
        <X class="h-3.5 w-3.5" />
      </button>
    {/if}
  </div>

  {#if !term.trim() && starredBundleIdsState.items.length > 0}
    <div class="mt-2.5 flex flex-wrap gap-1.5">
      {#each starredBundleIdsState.items as bundleId (bundleId)}
        <span class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 font-mono text-[11.5px]">
          <button class="cursor-pointer" onclick={() => pickRecent(bundleId)}>{bundleId}</button>
          <button
            class="text-warn hover:text-err cursor-pointer rounded-full p-0.5"
            onclick={() => toggleStarredBundleId(bundleId)}
            aria-label="Unstar {bundleId}"
            title="Unstar"
          >
            <Star class="h-3 w-3" fill="currentColor" />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  {#if !term.trim() && recentBundleIdsState.items.length > 0}
    <div class="mt-2.5 flex flex-wrap gap-1.5">
      {#each recentBundleIdsState.items as bundleId (bundleId)}
        <span class="border-border text-muted hover:text-text hover:border-accent inline-flex items-center gap-1 rounded-full border pr-1 pl-2.5 py-1 font-mono text-[11.5px]">
          <button class="cursor-pointer" onclick={() => pickRecent(bundleId)}>{bundleId}</button>
          <button
            class="text-muted hover:text-err cursor-pointer rounded-full p-0.5"
            onclick={() => removeRecentBundleId(bundleId)}
            aria-label="Remove {bundleId} from recents"
            title="Remove from recents"
          >
            <X class="h-3 w-3" />
          </button>
        </span>
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
          {:else}
            <div class="flex items-center gap-1.5">
              <button
                class={cn('cursor-pointer rounded-md p-1.5', isStarredBundleId(r.bundleId) ? 'text-warn' : 'text-muted hover:text-text')}
                onclick={() => toggleStarredBundleId(r.bundleId)}
                aria-label={isStarredBundleId(r.bundleId) ? `Unstar ${r.bundleId}` : `Star ${r.bundleId}`}
                title={isStarredBundleId(r.bundleId) ? 'Unstar' : 'Star'}
              >
                <Star class="h-3.5 w-3.5" fill={isStarredBundleId(r.bundleId) ? 'currentColor' : 'none'} />
              </button>
              {#if canDecrypt}
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => openVersions(r.bundleId, r.trackName)}
                  title="Browse version history"
                  aria-label="Browse version history"
                >
                  <History class="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onclick={() => openTestFlight(r.bundleId, r.trackId, r.trackName)}
                  title="Browse TestFlight builds"
                  aria-label="Browse TestFlight builds"
                >
                  <FlaskConical class="h-3.5 w-3.5" />
                </Button>
              {/if}
              {#if statusByBundle.has(r.bundleId)}
                {@const status = statusByBundle.get(r.bundleId) ?? ''}
                <Badge variant={statusToBadgeVariant(status)}>{status}</Badge>
              {:else if canDecrypt}
                <Button size="sm" loading={queueing.has(r.bundleId)} onclick={() => queue(r.bundleId, r.trackName)}>Decrypt</Button>
              {:else}
                <Badge variant="secondary" title="Viewers can't queue decrypts">view only</Badge>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</Card>

<VersionPickerDialog
  open={versionsOpen}
  bundleId={versionsBundleId}
  trackName={versionsTrackName}
  onOpenChange={(v) => (versionsOpen = v)}
  onDecrypt={decryptVersion}
/>

<TestFlightPickerDialog
  open={testflightOpen}
  bundleId={testflightBundleId}
  appId={testflightAppId}
  trackName={testflightTrackName}
  onOpenChange={(v) => (testflightOpen = v)}
  onDecrypt={decryptTestFlightBuild}
/>
