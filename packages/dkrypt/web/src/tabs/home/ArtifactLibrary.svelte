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
  import { fmtBytesGB, fmtSize } from '#lib/format';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';

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
          <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load()} placeholder="Search apps or versions…" class="min-w-0 flex-1 sm:w-64" />
          <Button variant="ghost" size="icon" class="text-muted hover:text-foreground h-8 w-8 shrink-0 p-0" disabled={loading} onclick={() => void load()} aria-label="Refresh IPA Library" title="Refresh IPA Library">
            <RefreshCw class={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          </Button>
        </div>
      </div>

      <div class="p-4 sm:p-5">
        {#if error}
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
                <a href={artifact.fileUrl} download class="{buttonVariants('secondary', 'sm')} w-full justify-center sm:col-start-2 sm:row-start-1 sm:w-auto lg:col-start-3 lg:row-start-1">
                  <Download class="h-3.5 w-3.5" />Download
                </a>
              </article>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </Card>
{/if}
