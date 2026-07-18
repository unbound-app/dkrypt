<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import { fetchAppVersions, type AppVersionEntry } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { fmtTime } from '../../lib/format';

  interface Props {
    open: boolean;
    bundleId: string;
    trackName: string;
    onOpenChange: (open: boolean) => void;
    onDecrypt: (bundleId: string, externalVersionId: string, label: string) => void;
  }

  let { open, bundleId, trackName, onOpenChange, onDecrypt }: Props = $props();

  let versions = $state<AppVersionEntry[] | null>(null);
  let error = $state('');
  let loadedFor = $state('');
  let refreshing = $state(false);

  function load(id: string, force = false): void {
    loadedFor = id;
    error = '';
    if (force) refreshing = true;
    else versions = null;
    fetchAppVersions(id, force)
      .then((data) => {
        if ('error' in data) {
          error = data.error;
          if (!force) versions = [];
        } else {
          versions = data.versions;
        }
      })
      .catch(() => {
        error = 'Failed to load version history - try again.';
        if (!force) versions = [];
      })
      .finally(() => {
        refreshing = false;
      });
  }

  $effect(() => {
    if (!open || bundleId === loadedFor) return;
    load(bundleId);
  });

  function retry(): void {
    load(bundleId);
  }

  function refresh(): void {
    load(bundleId, true);
  }

  function label(v: AppVersionEntry): string {
    return v.displayVersion ? `v${v.displayVersion}` : `id ${v.externalVersionId}`;
  }

  let search = $state('');

  const filteredVersions = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q || !versions) return versions ?? [];
    return versions.filter((v) => label(v).toLowerCase().includes(q) || v.externalVersionId.toLowerCase().includes(q));
  });
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-3 flex items-center justify-between gap-2">
    <div class="text-sm font-medium">{trackName} - version history</div>
    {#if versions !== null}
      <button
        type="button"
        class="text-muted hover:text-text cursor-pointer disabled:opacity-50"
        disabled={refreshing}
        onclick={refresh}
        aria-label="Refresh version list"
        title="Refresh version list"
      >
        <RefreshCw class="h-3.5 w-3.5 {refreshing ? 'animate-spin' : ''}" />
      </button>
    {/if}
  </div>

  {#if versions === null}
    <div class="text-sm text-muted">Loading version list from the App Store…</div>
  {:else if error}
    <div class="text-err mb-2.5 text-[13px]">{error}</div>
    <Button size="sm" variant="secondary" onclick={retry}>Try again</Button>
  {:else if versions.length === 0}
    <div class="text-sm text-muted">No version history found.</div>
  {:else}
    {#if versions.some((v) => !v.displayVersion)}
      <div class="text-muted mb-3 text-xs">Unlabeled versions are listed by App Store ID.</div>
    {/if}
    {#if versions.length > 8}
      <Input placeholder="Search versions…" bind:value={search} class="mb-3" />
    {/if}
    {#if filteredVersions.length === 0}
      <div class="text-sm text-muted">No versions match "{search}".</div>
    {/if}
    <div class="max-h-[50vh] overflow-y-auto">
      {#each filteredVersions as v (v.externalVersionId)}
        <div class="border-border flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 text-[13px]">
              {label(v)}
              {#if v.isLatest}
                <Badge variant="default">latest</Badge>
              {/if}
            </div>
            {#if v.releaseDate}
              <div class="text-muted text-xs">{fmtTime(new Date(v.releaseDate).getTime())}</div>
            {/if}
          </div>
          <Button size="sm" onclick={() => onDecrypt(bundleId, v.externalVersionId, label(v))}>Decrypt</Button>
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
