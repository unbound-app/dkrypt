<script lang="ts">
  import { Download, RefreshCw } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchArtifacts, type ArtifactRecord } from '#lib/api';
  import { appDisplayName, appIconUrl, ensureAppCatalog } from '#lib/appCatalog.svelte';
  import { fmtBytesGB, fmtRelative, fmtSize } from '#lib/format';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';

  const canDecrypt = $derived(sessionHasPermission(PermissionFlag.requestDecrypt));
  let artifacts = $state<ArtifactRecord[]>([]);
  let total = $state(0);
  let totalBytes = $state(0);
  let maxBytes = $state(0);
  let query = $state('');
  let loading = $state(false);
  let error = $state('');

  async function load(): Promise<void> {
    if (!canDecrypt) return;
    loading = true;
    error = '';
    try {
      const result = await fetchArtifacts(0, 50, query.trim() || undefined);
      artifacts = result.artifacts;
      total = result.total;
      totalBytes = result.totalBytes;
      maxBytes = result.maxBytes;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Failed to load artifacts';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
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
</script>

{#if canDecrypt}
  <Card>
    <div class="mb-4 flex flex-wrap items-start gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <div class="text-sm font-medium">IPA Library</div>
          <Badge variant="secondary">{total}</Badge>
        </div>
        <div class="text-muted mt-1 text-xs">{fmtBytesGB(totalBytes)} / {fmtBytesGB(maxBytes)} used</div>
      </div>
      <div class="flex w-full items-center gap-2 sm:w-auto sm:min-w-[18rem]">
        <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load()} placeholder="Search apps or versions…" class="min-w-0 flex-1 sm:w-64" />
        <button type="button" class="text-muted hover:text-text cursor-pointer disabled:opacity-50" disabled={loading} onclick={() => void load()} aria-label="Refresh IPA Library" title="Refresh IPA Library">
          <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
        </button>
      </div>
    </div>

    {#if error}
      <div class="text-err text-[13px]">{error}</div>
    {:else if artifacts.length === 0 && !loading}
      <EmptyState message="No artifacts match this search." />
    {:else}
      <div class="divide-border max-h-[34rem] divide-y overflow-y-auto pr-1">
        {#each artifacts as artifact (artifact.id)}
          <div class="grid gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center xl:grid-cols-[minmax(0,1fr)_44rem_auto]">
            <div class="flex min-w-0 items-center gap-3">
              <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-10 w-10" />
              <div class="min-w-0">
                <div class="truncate text-[13px] font-semibold">{appDisplayName(artifact.bundleId)}</div>
                <div class="text-muted mt-0.5 truncate text-xs" title={artifact.bundleId}>{artifact.bundleId}</div>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-x-5 gap-y-2 text-xs sm:col-span-2 sm:grid-cols-4 xl:col-span-1 xl:w-[44rem]">
              <div class="min-w-0 text-center">
                <div class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Version</div>
                <div class="mt-0.5 truncate text-[13px] font-semibold" title={artifact.buildNumber ? `${artifact.versionLabel ?? ''} (${artifact.buildNumber})` : artifact.versionLabel}>{artifactVersion(artifact)}</div>
              </div>
              <div class="text-center">
                <div class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Source</div>
                <div class="mt-0.5"><Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge></div>
              </div>
              <div class="text-center">
                <div class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Size</div>
                <div class="mt-0.5 text-[13px]">{fmtSize(artifact.fileSizeBytes)}</div>
              </div>
              <div class="min-w-0 text-center">
                <div class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">Last accessed</div>
                <div class="text-muted mt-0.5 truncate" title={new Date(artifact.lastAccessedAt).toLocaleString()}>{fmtRelative(new Date(artifact.lastAccessedAt).getTime())}</div>
              </div>
            </div>
            <a href={artifact.fileUrl} download class="sm:justify-self-end">
              <Button size="sm" variant="secondary"><Download class="h-3.5 w-3.5" />Download</Button>
            </a>
          </div>
        {/each}
      </div>
    {/if}
  </Card>
{/if}
