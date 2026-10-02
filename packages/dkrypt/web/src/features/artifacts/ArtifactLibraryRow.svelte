<script lang="ts">
  import { Archive, ArchiveRestore, Download, FileSearch, Pin, PinOff } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { appDisplayName, appIconUrl } from '#lib/appCatalog.svelte';
  import { fmtDateTime, fmtSize } from '#lib/format.svelte';
  import type { ArtifactRecord } from '#lib/api';
  import type { ArtifactColumnId } from '#lib/ui.svelte';

  let {
    artifact,
    columns,
    listView,
    canManageStorage,
    canSelect,
    selected,
    selectionDisabled,
    updating,
    onSelection,
    onPin,
    onArchive,
    onDetails,
  }: {
    artifact: ArtifactRecord;
    columns: ArtifactColumnId[];
    listView: boolean;
    canManageStorage: boolean;
    canSelect: boolean;
    selected: boolean;
    selectionDisabled: boolean;
    updating: boolean;
    onSelection: (selected: boolean) => void;
    onPin: () => void;
    onArchive: () => void;
    onDetails: () => void;
  } = $props();

  const artifactVersion = $derived.by(() => {
    const value = artifact.versionLabel?.trim().replace(/^TestFlight\s+/i, '').replace(/^v(?=\d)/i, '');
    if (!value) return 'Version unavailable';
    const version = artifact.channel === 'testflight' ? value.split('_', 1)[0] : value;
    return artifact.buildNumber ? `${version} (${artifact.buildNumber})` : version;
  });
</script>

<article data-artifact-id={artifact.id} class={listView ? 'grid gap-y-2.5 px-3.5 py-3 first:pt-3 last:pb-3 sm:px-4' : 'grid gap-3 rounded-xl border border-border/70 bg-background/50 p-4'}>
  <div class={canSelect ? 'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2'}>
    {#if canSelect}
      <input type="checkbox" class="accent-accent col-start-1 row-start-1 mt-1 size-4 shrink-0 rounded border-border" checked={selected} disabled={selectionDisabled} onchange={(event) => onSelection(event.currentTarget.checked)} aria-label="Select {appDisplayName(artifact.bundleId)} {artifactVersion}" />
    {/if}
    <div class={canSelect ? 'col-start-2 row-start-1 min-w-0' : 'col-start-1 row-start-1 min-w-0'}>
      <dl class="grid min-w-0 gap-x-2 gap-y-2 text-xs" style="grid-template-columns: repeat(auto-fit, minmax(min(100%, 6rem), 1fr))">
        {#each columns as column (column)}
          <div class="min-w-0">
            <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">{column === 'app' ? 'App' : column === 'bundleId' ? 'Bundle ID' : column === 'version' ? 'Version' : column === 'source' ? 'Source' : column === 'size' ? 'Size' : 'Added'}</dt>
            <dd class="mt-1 flex min-h-6 min-w-0 items-center gap-2 text-[13px]">
              {#if column === 'app'}
                <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-7 w-7 shrink-0" />
                <span class="truncate font-semibold">{appDisplayName(artifact.bundleId)}</span>
                {#if artifact.pinnedAt}<Badge variant="success">Pinned</Badge>{/if}
              {:else if column === 'bundleId'}
                <span class="truncate font-mono text-[11px]" data-sensitive="true">{artifact.bundleId}</span>
              {:else if column === 'version'}
                <span class="truncate font-semibold">{artifactVersion}</span>
              {:else if column === 'source'}
                <Badge variant={artifact.channel === 'testflight' ? 'secondary' : 'default'}>{artifact.channel === 'testflight' ? 'TestFlight' : 'App Store'}</Badge>
              {:else if column === 'size'}
                <span>{fmtSize(artifact.fileSizeBytes)}</span>
              {:else}
                <span class="truncate">{fmtDateTime(artifact.createdAt)}</span>
              {/if}
            </dd>
          </div>
        {/each}
      </dl>
    </div>
    <div class={canSelect ? 'col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1 sm:col-start-3 sm:row-start-1' : 'col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1 sm:row-start-1'}>
      {#if canManageStorage}
        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" disabled={updating} onclick={onPin} aria-label={artifact.pinnedAt ? `Unpin ${artifact.bundleId}` : `Pin ${artifact.bundleId}`} title={artifact.pinnedAt ? 'Unpin artifact' : 'Keep artifact from automatic eviction'}>
          {#if artifact.pinnedAt}<PinOff class="h-4 w-4" />{:else}<Pin class="h-4 w-4" />{/if}
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" disabled={updating} onclick={onArchive} aria-label={artifact.archivedAt ? `Restore ${artifact.bundleId}` : `Archive ${artifact.bundleId}`} title={artifact.archivedAt ? 'Restore to active library' : 'Hide from active library'}>
          {#if artifact.archivedAt}<ArchiveRestore class="h-4 w-4" />{:else}<Archive class="h-4 w-4" />{/if}
        </Button>
      {/if}
      <a href={artifact.fileUrl} download class="{buttonVariants('secondary', 'sm')} justify-center"><Download class="h-3.5 w-3.5" />Download</a>
    </div>
  </div>
  <div class="col-span-full flex justify-start"><Button data-list-primary-action variant="ghost" size="sm" onclick={onDetails}><FileSearch class="h-3.5 w-3.5" />Artifact details</Button></div>
</article>
