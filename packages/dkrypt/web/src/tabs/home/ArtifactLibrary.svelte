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
</script>

{#if canDecrypt}
  <Card>
    <div class="mb-3 flex flex-wrap items-center gap-2">
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium">IPA Library</div>
        <div class="text-muted text-xs">{total} artifact{total === 1 ? '' : 's'} · {fmtBytesGB(totalBytes)} / {fmtBytesGB(maxBytes)} used</div>
      </div>
      <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load()} placeholder="Search apps or versions…" class="order-3 min-w-[14rem] flex-1 sm:order-none" />
      <button type="button" class="text-muted hover:text-text cursor-pointer disabled:opacity-50" disabled={loading} onclick={() => void load()} aria-label="Refresh IPA Library" title="Refresh IPA Library">
        <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
      </button>
    </div>

    {#if error}
      <div class="text-err text-[13px]">{error}</div>
    {:else if artifacts.length === 0 && !loading}
      <EmptyState message="No artifacts match this search." />
    {:else}
      <div class="divide-border max-h-96 divide-y overflow-y-auto pr-1">
        {#each artifacts as artifact (artifact.id)}
          <div class="flex flex-wrap items-center gap-2 py-2">
            <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-8 w-8" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13px] font-medium">{appDisplayName(artifact.bundleId)}</div>
              <div class="text-muted truncate text-xs" title={artifact.bundleId}>{artifact.bundleId}</div>
            </div>
            <div class="min-w-32 text-xs sm:w-40">
              <div class="flex flex-wrap items-center gap-1.5">
                <span>{artifact.versionLabel ?? 'Unknown version'}</span>
                {#if artifact.buildNumber}<span class="text-muted">build {artifact.buildNumber}</span>{/if}
              </div>
              <div class="text-muted flex items-center gap-1.5">
                <Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge>
                <span>{fmtSize(artifact.fileSizeBytes)}</span>
              </div>
            </div>
            <div class="text-muted w-24 text-right text-xs" title={new Date(artifact.lastAccessedAt).toLocaleString()}>
              last {fmtRelative(new Date(artifact.lastAccessedAt).getTime())}
            </div>
            <a href={artifact.fileUrl} download>
              <Button size="sm" variant="secondary"><Download class="h-3.5 w-3.5" />Download</Button>
            </a>
          </div>
        {/each}
      </div>
    {/if}
  </Card>
{/if}
