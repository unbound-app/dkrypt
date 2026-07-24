<script lang="ts">
  import { ChevronDown, RefreshCw } from 'lucide-svelte';
  import { fetchTestFlightBuilds, fetchTestFlightTrains, type TFBuild, type TFTrain } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fmtTime } from '#lib/format';

  interface Props {
    open: boolean;
    bundleId: string;
    appId: number;
    trackName: string;
    onOpenChange: (open: boolean) => void;
    onDecrypt: (bundleId: string, appId: number, build: TFBuild, label: string) => void;
  }

  let { open, bundleId, appId, trackName, onOpenChange, onDecrypt }: Props = $props();

  let trains = $state<TFTrain[] | null>(null);
  let error = $state('');
  let loadedFor = $state(0);

  let expandedTrain = $state('');

  let buildsCache = $state<Record<string, TFBuild[]>>({});
  let loadingTrain = $state('');
  let buildsError = $state('');

  let refreshingTrains = $state(false);
  let newBuildIds = $state<Set<number>>(new Set());

  async function refreshExpandedTrainBuilds(trainVersion: string): Promise<void> {
    const oldIds = new Set((buildsCache[trainVersion] ?? []).map((b) => b.id));
    const data = await fetchTestFlightBuilds(appId, trainVersion);
    if ('error' in data) return;
    buildsCache = { ...buildsCache, [trainVersion]: data.builds };
    newBuildIds = new Set(data.builds.filter((b) => !oldIds.has(b.id)).map((b) => b.id));
  }

  function load(id: number, force = false): void {
    loadedFor = id;
    error = '';
    if (!force) {
      expandedTrain = '';
      buildsCache = {};
    }
    loadingTrain = '';
    buildsError = '';
    newBuildIds = new Set();
    const prevCount = force && expandedTrain ? trains?.find((t) => t.trainVersion === expandedTrain)?.buildCount : undefined;
    if (force) refreshingTrains = true;
    else trains = null;
    fetchTestFlightTrains(id)
      .then((data) => {
        if ('error' in data) {
          error = data.error;
          if (!force) trains = [];
          return;
        }
        trains = data.trains;
        if (force && expandedTrain) {
          const updated = data.trains.find((t) => t.trainVersion === expandedTrain);
          if (updated && updated.buildCount !== prevCount) void refreshExpandedTrainBuilds(expandedTrain);
        }
      })
      .catch(() => {
        error = 'Failed to load TestFlight trains - try again.';
        if (!force) trains = [];
      })
      .finally(() => {
        refreshingTrains = false;
      });
  }

  $effect(() => {
    if (!open || appId === loadedFor) return;
    load(appId);
  });

  function retry(): void {
    load(appId);
  }

  function refresh(): void {
    load(appId, true);
  }

  async function loadBuilds(trainVersion: string): Promise<void> {
    buildsError = '';
    loadingTrain = trainVersion;
    try {
      const data = await fetchTestFlightBuilds(appId, trainVersion);
      if ('error' in data) {
        buildsError = data.error;
      } else {
        buildsCache = { ...buildsCache, [trainVersion]: data.builds };
      }
    } catch {
      buildsError = 'Failed to load builds - try again.';
    } finally {
      if (loadingTrain === trainVersion) loadingTrain = '';
    }
  }

  function toggleTrain(trainVersion: string): void {
    if (expandedTrain === trainVersion) {
      expandedTrain = '';
      return;
    }
    expandedTrain = trainVersion;
    buildsError = '';
    newBuildIds = new Set();
    if (!buildsCache[trainVersion]) void loadBuilds(trainVersion);
  }

  function label(b: TFBuild): string {
    return `v${b.cfBundleShortVersion} (${b.cfBundleVersion})`;
  }

  let search = $state('');

  const filteredTrains = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q || !trains) return trains ?? [];
    return trains.filter((t) => t.trainVersion.toLowerCase().includes(q));
  });
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-3 flex items-center justify-between gap-2">
    <div class="text-sm font-medium">{trackName} - TestFlight builds</div>
    {#if trains !== null}
      <button
        type="button"
        class="text-muted hover:text-text cursor-pointer disabled:opacity-50"
        disabled={refreshingTrains}
        onclick={refresh}
        aria-label="Refresh TestFlight builds"
        title="Refresh TestFlight builds"
      >
        <RefreshCw class="h-3.5 w-3.5 {refreshingTrains ? 'animate-spin' : ''}" />
      </button>
    {/if}
  </div>

  {#if trains === null}
    <div class="text-sm text-muted">Loading TestFlight builds (may open TestFlight on device)…</div>
  {:else if error}
    <div class="text-err mb-2.5 text-[13px]">{error}</div>
    <Button size="sm" variant="secondary" onclick={retry}>Try again</Button>
  {:else if trains.length === 0}
    <div class="text-sm text-muted">No beta trains found - is this app in your TestFlight?</div>
  {:else}
    {#if trains.length > 8}
      <Input placeholder="Search trains…" bind:value={search} class="mb-3" />
    {/if}
    {#if filteredTrains.length === 0}
      <div class="text-sm text-muted">No trains match "{search}".</div>
    {/if}
    <div class="max-h-[55vh] overflow-y-auto">
      {#each filteredTrains as t (t.trainVersion)}
        <div class="border-border border-t py-2 first:border-t-0">
          <button
            class="flex w-full cursor-pointer items-center justify-between gap-3 text-left text-[13px]"
            onclick={() => toggleTrain(t.trainVersion)}
          >
            <span class="flex items-center gap-1.5">
              <ChevronDown class="h-3.5 w-3.5 shrink-0 text-muted transition-transform {expandedTrain === t.trainVersion ? 'rotate-180' : ''}" />
              v{t.trainVersion}
            </span>
            <Badge variant="secondary">{t.buildCount} build{t.buildCount === 1 ? '' : 's'}</Badge>
          </button>

          {#if expandedTrain === t.trainVersion}
            <div class="mt-2 pl-3">
              {#if loadingTrain === t.trainVersion}
                <div class="text-muted text-xs">Loading builds…</div>
              {:else if buildsError}
                <div class="text-err mb-1.5 text-xs">{buildsError}</div>
                <Button size="sm" variant="secondary" onclick={() => loadBuilds(t.trainVersion)}>Try again</Button>
              {:else}
                {#each buildsCache[t.trainVersion] ?? [] as b (b.id)}
                  <div class="flex items-center justify-between gap-3 py-1.5">
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5 text-[13px]">
                        {label(b)}
                        {#if newBuildIds.has(b.id)}<Badge variant="success">New</Badge>{/if}
                      </div>
                      {#if b.releaseDate}
                        <div class="text-muted text-xs">{fmtTime(new Date(b.releaseDate).getTime())}</div>
                      {/if}
                    </div>
                    <Button size="sm" onclick={() => onDecrypt(bundleId, appId, b, label(b))}>Install &amp; decrypt</Button>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
