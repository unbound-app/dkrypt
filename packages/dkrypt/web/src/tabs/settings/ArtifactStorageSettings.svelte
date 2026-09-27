<script lang="ts">
  import { onMount } from 'svelte';
  import { HardDrive, RefreshCw } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchArtifactStorageStats, previewArtifactQuotaRetention, type ArtifactQuotaRetentionPreview, type ArtifactStorageStats } from '#lib/api';
  import { fmtBytesGB, fmtSize } from '#lib/format';

  let storageStats = $state<ArtifactStorageStats | null>(null);
  let storageLoading = $state(false);
  let storageError = $state('');
  let proposedQuotaGb = $state('');
  let quotaPreview = $state<ArtifactQuotaRetentionPreview | null>(null);
  let quotaPreviewLoading = $state(false);
  let quotaPreviewError = $state('');

  function formatQuotaInput(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(9).replace(/\.?0+$/, '');
  }

  async function loadStorageStats(): Promise<void> {
    storageLoading = true;
    storageError = '';
    try {
      storageStats = await fetchArtifactStorageStats();
      if (!proposedQuotaGb && storageStats.maxBytes > 0) proposedQuotaGb = formatQuotaInput(storageStats.maxBytes);
    } catch (error) {
      storageError = error instanceof Error ? error.message : 'Could not load IPA storage details';
    } finally {
      storageLoading = false;
    }
  }

  async function simulateQuota(): Promise<void> {
    const targetMaxBytes = Math.round(Number(proposedQuotaGb) * 1024 ** 3);
    if (!Number.isSafeInteger(targetMaxBytes) || targetMaxBytes < 1) {
      quotaPreviewError = 'Enter a positive storage quota.';
      quotaPreview = null;
      return;
    }
    quotaPreviewLoading = true;
    quotaPreviewError = '';
    try {
      quotaPreview = await previewArtifactQuotaRetention(targetMaxBytes);
    } catch (error) {
      quotaPreviewError = error instanceof Error ? error.message : 'Could not simulate this quota';
      quotaPreview = null;
    } finally {
      quotaPreviewLoading = false;
    }
  }

  onMount(() => {
    void loadStorageStats();
  });
</script>

<Card class="overflow-hidden">
  <div class="flex items-start justify-between gap-3">
    <div class="flex min-w-0 items-start gap-3">
      <div class="bg-muted/40 text-muted mt-0.5 rounded-md p-2"><HardDrive class="h-4 w-4" /></div>
      <div class="min-w-0">
        <h2 class="text-sm font-semibold">IPA storage</h2>
        <p class="text-muted mt-1 text-xs">Preview which files would be removed if the storage quota changed. This does not change settings or delete files.</p>
      </div>
    </div>
    <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" disabled={storageLoading} onclick={() => void loadStorageStats()} aria-label="Refresh IPA storage details" title="Refresh storage details">
      <RefreshCw class={storageLoading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
    </Button>
  </div>

  {#if storageError}
    <div class="text-err mt-4 text-xs" role="alert">{storageError}</div>
  {:else if storageStats}
    <div class="mt-4 rounded-lg border border-border/70 bg-muted/20 px-3 py-2.5 text-xs">
      <span class="font-medium">Current usage:</span> {fmtBytesGB(storageStats.usedBytes)} of {fmtBytesGB(storageStats.maxBytes)} across {storageStats.count} IPA files
    </div>
  {:else}
    <div class="text-muted mt-4 text-xs" role="status">Loading storage details…</div>
  {/if}

  <div class="mt-4 flex flex-wrap items-end gap-2">
    <label class="text-muted text-xs">
      Proposed quota (GB)
      <Input class="mt-1 w-36" type="number" min="0" step="any" bind:value={proposedQuotaGb} aria-label="Proposed artifact quota in gigabytes" />
    </label>
    <Button variant="default" size="sm" loading={quotaPreviewLoading} onclick={() => void simulateQuota()}>Preview changes</Button>
  </div>

  {#if quotaPreviewError}
    <div class="text-err mt-3 text-xs" role="alert">{quotaPreviewError}</div>
  {:else if quotaPreview}
    <div class="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3 text-xs" aria-live="polite">
      <div class="font-medium">
        {#if quotaPreview.remainingOverQuotaBytes > 0}
          Pinned files exceed this quota by {fmtBytesGB(quotaPreview.remainingOverQuotaBytes)}. Unpin files or raise the quota before storing more.
        {:else if quotaPreview.evictedCount > 0}
          Would keep {quotaPreview.retainedCount} of {quotaPreview.currentCount} files, reclaiming {fmtBytesGB(quotaPreview.reclaimedBytes)}.
        {:else}
          No files would be evicted at this quota.
        {/if}
      </div>
      <div class="text-muted mt-1">Retained storage: {fmtBytesGB(quotaPreview.retainedBytes)} / {fmtBytesGB(quotaPreview.targetMaxBytes)}. {quotaPreview.pinnedCount} pinned files ({fmtBytesGB(quotaPreview.pinnedBytes)}) are protected.</div>
      {#if quotaPreview.evictionExamples.length > 0}
        <ul class="mt-2 divide-y divide-border/70">
          {#each quotaPreview.evictionExamples.slice(0, 5) as candidate (candidate.id)}
            <li class="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
              <span class="min-w-0 truncate" title={candidate.bundleId}>{candidate.bundleId}{candidate.versionLabel ? ` · ${candidate.versionLabel}` : ''}</span>
              <span class="text-muted shrink-0">{fmtSize(candidate.fileSizeBytes)}</span>
            </li>
          {/each}
        </ul>
        {#if quotaPreview.evictedCount > Math.min(quotaPreview.evictionExamples.length, 5)}
          <div class="text-muted mt-1.5">and {quotaPreview.evictedCount - Math.min(quotaPreview.evictionExamples.length, 5)} more oldest files</div>
        {/if}
      {/if}
    </div>
  {/if}
</Card>
