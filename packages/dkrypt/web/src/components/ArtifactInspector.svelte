<script lang="ts">
  import { onDestroy } from 'svelte';
  import { Download, FileSearch } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import InspectorPane from '#components/InspectorPane.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { fetchDashboardArtifact, type ArtifactRecord } from '#lib/api';
  import { appDisplayName, appIconUrl } from '#lib/appCatalog.svelte';
  import { fmtSize, fmtTime } from '#lib/format.svelte';
  import { projectSelectionState } from '#lib/projectSelection.svelte';
  import { artifactDetailJumpState } from '#lib/ui.svelte';

  let artifact = $state<ArtifactRecord | null>(null);
  let open = $state(false);
  let error = $state('');
  let loading = $state(false);
  let requestVersion = 0;

  async function loadArtifact(id: string, projectId: string): Promise<void> {
    const version = ++requestVersion;
    loading = true;
    error = '';
    open = true;
    try {
      const result = await fetchDashboardArtifact(id, projectId);
      if (version === requestVersion) artifact = result;
    } catch (cause) {
      if (version === requestVersion) error = cause instanceof Error ? cause.message : 'Could not load artifact details';
    } finally {
      if (version === requestVersion) loading = false;
    }
  }

  $effect(() => {
    const id = artifactDetailJumpState.id;
    const projectId = projectSelectionState.id;
    if (!id) return;
    artifactDetailJumpState.id = null;
    void loadArtifact(id, projectId);
  });

  function closeInspector(next: boolean): void {
    open = next;
    if (!next) {
      requestVersion += 1;
      artifact = null;
      loading = false;
      error = '';
      artifactDetailJumpState.id = null;
    }
  }

  onDestroy(() => {
    requestVersion += 1;
  });
</script>

<InspectorPane bind:open title="Artifact details" onOpenChange={closeInspector}>
  {#if loading}
    <div class="py-12 text-center text-sm text-muted" role="status">Loading artifact details…</div>
  {:else if error}
    <div class="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-err" role="alert">{error}</div>
  {:else if artifact}
    <div class="mb-5 flex items-start gap-3">
      <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-12 w-12" />
      <div class="min-w-0 flex-1">
        <h2 class="truncate text-lg font-semibold">{appDisplayName(artifact.bundleId)}</h2>
        <div class="mt-1 break-all font-mono text-xs text-muted">{artifact.bundleId}</div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge>
          {#if artifact.versionLabel}<Badge variant="outline">{artifact.versionLabel}</Badge>{/if}
          {#if artifact.pinnedAt}<Badge variant="success">Pinned</Badge>{/if}
          {#if artifact.archivedAt}<Badge variant="secondary">Archived</Badge>{/if}
        </div>
      </div>
      <a href={artifact.fileUrl} download class={buttonVariants('secondary', 'sm')}><Download class="h-3.5 w-3.5" />Download</a>
    </div>
    <section class="rounded-xl border border-border/70 p-4" aria-labelledby="artifact-inspector-metadata">
      <h3 id="artifact-inspector-metadata" class="mb-3 flex items-center gap-2 text-sm font-semibold"><FileSearch class="h-4 w-4 text-accent" />Artifact metadata</h3>
      <dl class="grid gap-4 text-xs sm:grid-cols-2">
        <div><dt class="text-muted">Size</dt><dd class="mt-1 font-medium">{fmtSize(artifact.fileSizeBytes)}</dd></div>
        <div><dt class="text-muted">Build</dt><dd class="mt-1 font-medium">{artifact.buildNumber ?? 'Unavailable'}</dd></div>
        <div><dt class="text-muted">Created</dt><dd class="mt-1 font-medium">{fmtTime(Date.parse(artifact.createdAt))}</dd></div>
        <div><dt class="text-muted">Last accessed</dt><dd class="mt-1 font-medium">{fmtTime(Date.parse(artifact.lastAccessedAt))}</dd></div>
        <div><dt class="text-muted">Access count</dt><dd class="mt-1 font-medium">{artifact.accessCount}</dd></div>
        <div><dt class="text-muted">Source job</dt><dd class="mt-1 break-all font-mono">{artifact.sourceJobId ?? 'Unavailable'}</dd></div>
        <div class="sm:col-span-2"><dt class="text-muted">SHA-256</dt><dd class="mt-1 break-all font-mono">{artifact.sha256}</dd></div>
      </dl>
    </section>
    {#if artifact.warnings?.length}
      <section class="mt-4 rounded-xl border border-warn/30 bg-warn/5 p-4" aria-labelledby="artifact-inspector-warnings">
        <h3 id="artifact-inspector-warnings" class="text-sm font-semibold text-warn">Decrypt warnings</h3>
        <ul class="mt-2 space-y-2 break-words text-xs text-muted">
          {#each artifact.warnings as warning, index (`${artifact.id}-${index}`)}<li>{warning}</li>{/each}
        </ul>
      </section>
    {/if}
  {:else}
    <div class="py-12 text-center text-sm text-muted">Select an artifact to inspect its details.</div>
  {/if}
</InspectorPane>
