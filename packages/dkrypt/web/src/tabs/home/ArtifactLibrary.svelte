<script lang="ts">
  import { Download, RefreshCw } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { fetchArtifacts, type ArtifactRecord } from '#lib/api';
  import { fmtBytesGB, fmtSize } from '#lib/format';
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
      error = err instanceof Error ? err.message : 'Failed to load retained artifacts';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (canDecrypt) void load();
  });

  function formatDate(value: string): string {
    return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
</script>

{#if canDecrypt}
  <Card>
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div class="text-sm font-medium">Retained IPA library</div>
        <div class="text-muted text-xs">{total} artifact{total === 1 ? '' : 's'} · {fmtBytesGB(totalBytes)} / {fmtBytesGB(maxBytes)} used</div>
      </div>
      <button type="button" class="text-muted hover:text-text cursor-pointer disabled:opacity-50" disabled={loading} onclick={() => void load()} aria-label="Refresh retained artifacts" title="Refresh retained artifacts">
        <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
      </button>
    </div>

    <Input bind:value={query} onkeydown={(event) => event.key === 'Enter' && void load()} placeholder="Search bundle or version…" class="mb-3" />

    {#if error}
      <div class="text-err text-[13px]">{error}</div>
    {:else if artifacts.length === 0 && !loading}
      <EmptyState message="No retained IPAs match this search." />
    {:else}
      <div class="divide-border divide-y">
        {#each artifacts as artifact (artifact.id)}
          <div class="flex flex-wrap items-center justify-between gap-3 py-2.5">
            <div class="min-w-0">
              <div class="flex items-center gap-1.5 text-[13px]">
                <span class="truncate">{artifact.bundleId}</span>
                <Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge>
              </div>
              <div class="text-muted text-xs">{artifact.versionLabel ?? 'Unknown version'} · {fmtSize(artifact.fileSizeBytes)} · accessed {formatDate(artifact.lastAccessedAt)}</div>
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
