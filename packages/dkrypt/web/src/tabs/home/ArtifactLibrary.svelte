<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Download, Pin, PinOff, RefreshCw } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchArtifacts, observeArtifacts, previewArtifactQuotaRetention, setDashboardArtifactPinned, type ArtifactQuotaRetentionPreview, type ArtifactRecord } from '#lib/api';
  import { appDisplayName, appIconUrl, ensureAppCatalog } from '#lib/appCatalog.svelte';
  import { fmtBytesGB, fmtSize, fmtTime } from '#lib/format';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { isServerQueryCancelled, mergeServerPage, serverQueryStatus } from '#lib/serverStateCache.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { projectSelectionState } from '#lib/projectSelection.svelte';

  const canDecrypt = $derived(sessionHasPermission(PermissionFlag.requestDecrypt));
  const canManageStorage = $derived(sessionHasPermission(PermissionFlag.manageAutomation));
  let artifacts = $state<ArtifactRecord[]>([]);
  let total = $state(0);
  let totalBytes = $state(0);
  let maxBytes = $state(0);
  let query = $state('');
  let loading = $state(false);
  let loadingMore = $state(false);
  let pinningArtifactIds = $state<string[]>([]);
  let nextCursor = $state<string | undefined>(undefined);
  let error = $state('');
  let cacheStatus = $state('');
  let showQuotaSimulation = $state(false);
  let proposedQuotaGb = $state('');
  let quotaPreview = $state<ArtifactQuotaRetentionPreview | null>(null);
  let quotaPreviewLoading = $state(false);
  let quotaPreviewError = $state('');
  let stopObservingArtifacts: (() => void) | undefined;
  let artifactLoadVersion = 0;
  let activeArtifactQueryKey = '';

  async function load(force = false): Promise<void> {
    if (!canDecrypt) return;
    const loadVersion = ++artifactLoadVersion;
    stopObservingArtifacts?.();
    loading = true;
    error = '';
    nextCursor = undefined;
    const searchQuery = query.trim() || undefined;
    const artifactQuery = { cursorOrOffset: undefined, limit: 50, q: searchQuery };
    const artifactQueryKey = JSON.stringify([projectSelectionState.id, artifactQuery]);
    const previousArtifactQueryKey = activeArtifactQueryKey;
    activeArtifactQueryKey = artifactQueryKey;
    const request = fetchArtifacts(artifactQuery, force);
    const applyPage = (result: Awaited<ReturnType<typeof fetchArtifacts>>) => {
      artifacts = mergeServerPage(result.artifacts, artifacts, previousArtifactQueryKey, artifactQueryKey);
      total = result.total;
      totalBytes = result.totalBytes;
      maxBytes = result.maxBytes;
      if (!proposedQuotaGb) proposedQuotaGb = formatQuotaInput(result.maxBytes);
      nextCursor = result.nextCursor;
    };
    stopObservingArtifacts = observeArtifacts(artifactQuery, (snapshot) => {
      if (loadVersion !== artifactLoadVersion) return;
      if (snapshot.data) {
        applyPage(snapshot.data);
        cacheStatus = serverQueryStatus(snapshot);
        if (!snapshot.error) error = '';
      } else {
        cacheStatus = '';
        artifacts = [];
        total = 0;
        totalBytes = 0;
        maxBytes = 0;
        nextCursor = undefined;
      }
      loading = snapshot.isFetching;
    });
    try {
      await request;
    } catch (err) {
      if (loadVersion === artifactLoadVersion && !isServerQueryCancelled(err)) error = err instanceof Error ? err.message : 'Failed to load artifacts';
    }
  }

  onDestroy(() => {
    artifactLoadVersion += 1;
    stopObservingArtifacts?.();
  });

  async function loadMore(): Promise<void> {
    if (loadingMore || !nextCursor) return;
    loadingMore = true;
    try {
      const result = await fetchArtifacts({ cursorOrOffset: nextCursor, limit: 50, q: query.trim() || undefined });
      const seenIds = new Set(artifacts.map((artifact) => artifact.id));
      artifacts = [...artifacts, ...result.artifacts.filter((artifact) => !seenIds.has(artifact.id))];
      total = result.total;
      totalBytes = result.totalBytes;
      maxBytes = result.maxBytes;
      nextCursor = result.nextCursor;
    } catch (err) {
      if (!isServerQueryCancelled(err)) error = err instanceof Error ? err.message : 'Failed to load more artifacts';
    } finally {
      loadingMore = false;
    }
  }

  $effect(() => {
    projectSelectionState.id;
    if (canDecrypt) void load();
  });

  $effect(() => {
    if (canDecrypt) void ensureAppCatalog(artifacts.map((artifact) => artifact.bundleId));
  });

  function artifactVersion(artifact: ArtifactRecord): string {
    const value = artifact.versionLabel?.trim().replace(/^TestFlight\s+/i, '').replace(/^v(?=\d)/i, '');
    if (!value) return 'Version unavailable';
    const version = artifact.channel === 'testflight' ? value.split('_', 1)[0] : value;
    return artifact.buildNumber ? `${version} (${artifact.buildNumber})` : version;
  }

  function toggleQuotaSimulation(): void {
    showQuotaSimulation = !showQuotaSimulation;
    quotaPreviewError = '';
    if (!proposedQuotaGb && maxBytes > 0) proposedQuotaGb = formatQuotaInput(maxBytes);
  }

  function formatQuotaInput(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(9).replace(/\.?0+$/, '');
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
    } catch (err) {
      quotaPreviewError = err instanceof Error ? err.message : 'Could not simulate this quota';
      quotaPreview = null;
    } finally {
      quotaPreviewLoading = false;
    }
  }

  async function toggleArtifactPin(artifact: ArtifactRecord): Promise<void> {
    if (pinningArtifactIds.includes(artifact.id)) return;
    pinningArtifactIds = [...pinningArtifactIds, artifact.id];
    try {
      const result = await setDashboardArtifactPinned(artifact.id, artifact.pinnedAt === undefined);
      if (!result.ok) return;
      artifacts = artifacts.map((candidate) => candidate.id === artifact.id
        ? { ...candidate, pinnedAt: result.data.pinnedAt }
        : candidate);
    } finally {
      pinningArtifactIds = pinningArtifactIds.filter((id) => id !== artifact.id);
    }
  }
</script>

{#if canDecrypt}
  <Card class="overflow-hidden">
    <div class="-m-5 overflow-hidden">
      <div class="border-border/70 flex flex-col gap-3 border-b px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold tracking-tight">IPA Library</div>
            <Badge variant="secondary">{total}</Badge>
          </div>
          <div class="text-muted mt-0.5 text-xs">{fmtBytesGB(totalBytes)} / {fmtBytesGB(maxBytes)} used</div>
        </div>
        <div class="flex w-full items-center gap-2 sm:w-auto sm:min-w-[18rem]">
          <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load(true)} placeholder="Search apps or versions…" class="min-w-0 flex-1 sm:w-64" />
          <Button variant="ghost" size="icon" class="text-muted hover:text-foreground h-8 w-8 shrink-0 p-0" disabled={loading} onclick={() => void load(true)} aria-label="Refresh IPA Library" title="Refresh IPA Library">
            <RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          </Button>
        </div>
      </div>

      <div class="p-4 sm:p-5">
        {#if canManageStorage}
          <div class="mb-4 rounded-lg border border-border/70 p-3">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-xs font-semibold">Retention simulation</div>
                <div class="text-muted mt-0.5 text-xs">Preview which least-recently-accessed IPAs a storage quota would evict.</div>
              </div>
              <Button variant="secondary" size="sm" onclick={toggleQuotaSimulation}>{showQuotaSimulation ? 'Close' : 'Simulate quota'}</Button>
            </div>
            {#if showQuotaSimulation}
              <div class="mt-3 border-t border-border/70 pt-3" aria-live="polite">
                <div class="flex flex-wrap items-end gap-2">
                  <label class="text-muted text-xs">
                    Proposed quota (GB)
                    <Input class="mt-1 w-32" type="number" min="0" step="any" bind:value={proposedQuotaGb} aria-label="Proposed artifact quota in gigabytes" />
                  </label>
                  <Button variant="default" size="sm" loading={quotaPreviewLoading} onclick={() => void simulateQuota()}>Preview</Button>
                </div>
                {#if quotaPreviewError}
                  <div class="text-err mt-2 text-xs" role="alert">{quotaPreviewError}</div>
                {:else if quotaPreview}
                  <div class="mt-3 rounded-md bg-muted/20 p-2.5 text-xs">
                    <div class="font-medium">
                      {#if quotaPreview.remainingOverQuotaBytes > 0}
                        Pinned files exceed this quota by {fmtBytesGB(quotaPreview.remainingOverQuotaBytes)}. Unpin files or raise the quota before storing more.
                      {:else if quotaPreview.evictedCount > 0}
                        Would keep {quotaPreview.retainedCount} of {quotaPreview.currentCount} files, reclaiming {fmtBytesGB(quotaPreview.reclaimedBytes)}.
                      {:else}
                        No files would be evicted at this quota.
                      {/if}
                    </div>
                    <div class="text-muted mt-1">Retained storage: {fmtBytesGB(quotaPreview.retainedBytes)} / {fmtBytesGB(quotaPreview.targetMaxBytes)}. {quotaPreview.pinnedCount} pinned files ({fmtBytesGB(quotaPreview.pinnedBytes)}) are protected. The simulation does not change settings or delete files.</div>
                    {#if quotaPreview.evictionExamples.length > 0}
                      <ul class="mt-2 divide-y divide-border/70">
                        {#each quotaPreview.evictionExamples.slice(0, 5) as candidate (candidate.id)}
                          <li class="flex items-center justify-between gap-3 py-1.5 first:pt-0 last:pb-0">
                            <span class="min-w-0 truncate" title={candidate.bundleId}>{candidate.bundleId}{candidate.versionLabel ? ` · ${candidate.versionLabel}` : ''}</span>
                            <span class="shrink-0 text-muted">{fmtSize(candidate.fileSizeBytes)}</span>
                          </li>
                        {/each}
                      </ul>
                      {#if quotaPreview.evictedCount > Math.min(quotaPreview.evictionExamples.length, 5)}
                        <div class="text-muted mt-1.5">and {quotaPreview.evictedCount - Math.min(quotaPreview.evictionExamples.length, 5)} more oldest files</div>
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
        {#if cacheStatus}
          <div class="mb-3 rounded-md border border-border/70 px-3 py-2 text-xs text-muted" role="status" aria-live="polite">{cacheStatus}</div>
        {/if}
        {#if error && artifacts.length === 0}
          <div class="text-err text-[13px]" role="alert">{error}</div>
        {:else if artifacts.length === 0 && !loading}
          <EmptyState message="No artifacts match this search." />
        {:else}
          <div class="divide-border max-h-[34rem] divide-y overflow-y-auto rounded-xl border border-border/70">
            {#each artifacts as artifact (artifact.id)}
              <article class="grid gap-x-5 gap-y-2.5 px-3.5 py-3 first:pt-3 last:pb-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1.65fr)_auto] lg:items-center">
                <div class="flex min-w-0 items-center gap-3">
                  <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-9 w-9" />
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-[13px] font-semibold" title={appDisplayName(artifact.bundleId)}>{appDisplayName(artifact.bundleId)}</div>
                    {#if artifact.pinnedAt}<div class="text-muted mt-0.5 text-[10px]">Pinned</div>{/if}
                    <div class="text-muted mt-0.5 truncate font-mono text-[11px]" title={artifact.bundleId}>{artifact.bundleId}</div>
                  </div>
                </div>
                <dl class="col-span-full grid min-w-0 grid-cols-3 gap-x-3 text-xs sm:col-span-2 sm:col-start-1 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
                  <div class="min-w-0">
                    <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Version</dt>
                    <dd class="mt-0.5 truncate text-[13px] font-semibold" title={artifact.buildNumber ? `${artifact.versionLabel ?? ''} (${artifact.buildNumber})` : artifact.versionLabel}>{artifactVersion(artifact)}</dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Source</dt>
                    <dd class="mt-0.5"><Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge></dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Size</dt>
                    <dd class="mt-0.5 text-[13px]">{fmtSize(artifact.fileSizeBytes)}</dd>
                  </div>
                </dl>
                <div class="flex items-center justify-end gap-1 sm:col-start-2 sm:row-start-1 lg:col-start-3 lg:row-start-1">
                  {#if canManageStorage}
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-8 w-8 shrink-0"
                      disabled={pinningArtifactIds.includes(artifact.id)}
                      onclick={() => void toggleArtifactPin(artifact)}
                      aria-label={artifact.pinnedAt ? `Unpin ${artifact.bundleId}` : `Pin ${artifact.bundleId}`}
                      title={artifact.pinnedAt ? 'Unpin artifact' : 'Keep artifact from automatic eviction'}
                    >
                      {#if artifact.pinnedAt}<PinOff class="h-4 w-4" />{:else}<Pin class="h-4 w-4" />{/if}
                    </Button>
                  {/if}
                  <a href={artifact.fileUrl} download class="{buttonVariants('secondary', 'sm')} justify-center">
                    <Download class="h-3.5 w-3.5" />Download
                  </a>
                </div>
                <details class="col-span-full rounded-lg border border-border/70 px-3 py-2">
                  <summary class="cursor-pointer text-xs font-medium">Artifact details</summary>
                  <div class="mt-3 space-y-3">
                    <dl class="grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
                      <div class="min-w-0">
                        <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">SHA-256</dt>
                        <dd class="mt-1 break-all font-mono">{artifact.sha256}</dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Source job</dt>
                        <dd class="mt-1 break-all font-mono">{artifact.sourceJobId ?? 'Unavailable'}</dd>
                      </div>
                      <div>
                        <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Created</dt>
                        <dd class="mt-1">{fmtTime(Date.parse(artifact.createdAt))}</dd>
                      </div>
                      <div>
                        <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Last accessed</dt>
                        <dd class="mt-1">{fmtTime(Date.parse(artifact.lastAccessedAt))}</dd>
                      </div>
                    </dl>
                    {#if artifact.warnings?.length}
                      <div class="rounded-md border border-warn/30 bg-warn/5 p-2.5 text-xs" role="note">
                        <div class="font-semibold text-warn">Decrypt warnings</div>
                        <ul class="mt-1 max-h-40 space-y-1 overflow-y-auto break-words text-muted">
                          {#each artifact.warnings as warning, index (`${artifact.id}-${index}`)}
                            <li>{warning}</li>
                          {/each}
                        </ul>
                      </div>
                    {/if}
                  </div>
                </details>
              </article>
            {/each}
          </div>
          {#if nextCursor}
            <div class="mt-3 flex justify-center">
              <Button variant="secondary" size="sm" loading={loadingMore} onclick={() => void loadMore()}>Load more ({Math.max(0, total - artifacts.length)} older)</Button>
            </div>
          {/if}
        {/if}
      </div>
    </div>
  </Card>
{/if}
