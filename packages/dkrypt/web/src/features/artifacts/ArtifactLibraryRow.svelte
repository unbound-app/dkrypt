<script lang="ts">
  import { Archive, ArchiveRestore, Download, FileSearch, Pin, PinOff } from 'lucide-svelte';
  import AppIcon from '#components/AppIcon.svelte';
  import RevealText from '#components/RevealText.svelte';
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

<article data-artifact-id={artifact.id} class="artifact-library-row {listView ? 'grid gap-y-2.5 px-3.5 py-3 first:pt-3 last:pb-3 sm:px-4' : 'grid gap-3 rounded-xl border border-border/70 bg-background/50 p-4'}">
  <div class="artifact-library-row-content {canSelect ? 'grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)_auto]' : 'grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2'}" class:has-selection={canSelect}>
    {#if canSelect}
      <input type="checkbox" class="accent-accent col-start-1 row-start-1 mt-1 size-4 shrink-0 rounded border-border" checked={selected} disabled={selectionDisabled} onchange={(event) => onSelection(event.currentTarget.checked)} aria-label="Select {appDisplayName(artifact.bundleId)} {artifactVersion}" />
    {/if}
    <div class={canSelect ? 'col-start-2 row-start-1 min-w-0' : 'col-start-1 row-start-1 min-w-0'}>
      <dl class="artifact-library-row-metadata grid min-w-0 gap-x-2 gap-y-2 text-xs" class:five-columns={columns.length === 5}>
        {#each columns as column (column)}
          <div class="min-w-0">
            <dt class="text-muted text-[10px] font-semibold tracking-[0.08em] uppercase">{column === 'app' ? 'App' : column === 'bundleId' ? 'Bundle ID' : column === 'version' ? 'Version' : column === 'source' ? 'Source' : column === 'size' ? 'Size' : 'Added'}</dt>
            <dd class="mt-1 flex min-h-6 min-w-0 items-center gap-2 text-[13px]">
              {#if column === 'app'}
                <AppIcon bundleId={artifact.bundleId} src={appIconUrl(artifact.bundleId)} label={appDisplayName(artifact.bundleId)} class="h-7 w-7 shrink-0" />
                <RevealText value={appDisplayName(artifact.bundleId)} />
                {#if artifact.pinnedAt}<Badge variant="success">Pinned</Badge>{/if}
              {:else if column === 'bundleId'}
                <RevealText value={artifact.bundleId} monospace sensitive />
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
    <div class="artifact-library-row-actions {canSelect ? 'col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1 sm:col-start-3 sm:row-start-1' : 'col-start-2 row-start-2 flex min-w-0 items-center justify-end gap-1 sm:row-start-1'}">
      {#if canManageStorage}
        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" disabled={updating} onclick={onPin} aria-label={artifact.pinnedAt ? `Unpin ${artifact.bundleId}` : `Pin ${artifact.bundleId}`} title={artifact.pinnedAt ? 'Unpin artifact' : 'Keep artifact from automatic eviction'}>
          {#if artifact.pinnedAt}<PinOff class="h-4 w-4" />{:else}<Pin class="h-4 w-4" />{/if}
        </Button>
        <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" disabled={updating} onclick={onArchive} aria-label={artifact.archivedAt ? `Restore ${artifact.bundleId}` : `Archive ${artifact.bundleId}`} title={artifact.archivedAt ? 'Restore to active library' : 'Hide from active library'}>
          {#if artifact.archivedAt}<ArchiveRestore class="h-4 w-4" />{:else}<Archive class="h-4 w-4" />{/if}
        </Button>
      {/if}
      <Button data-list-primary-action variant="ghost" size="icon" class="h-8 w-8 shrink-0" onclick={onDetails} aria-label="Artifact details" title="Artifact details"><FileSearch class="h-4 w-4" /></Button>
      <a href={artifact.fileUrl} download class="{buttonVariants('secondary', 'sm')} justify-center"><Download class="h-3.5 w-3.5" />Download</a>
    </div>
  </div>
</article>

<style>
  .artifact-library-row {
    container-type: inline-size;
  }

  .artifact-library-row-metadata {
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 6rem), 1fr));
  }

  @container (max-width: 699px) {
    .artifact-library-row-content.has-selection {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .artifact-library-row-content:not(.has-selection) {
      grid-template-columns: minmax(0, 1fr);
    }

    .artifact-library-row-actions {
      grid-column: -2 / -1;
      grid-row: 2;
    }
  }

  @container (min-width: 700px) and (max-width: 800px) {
    .artifact-library-row-metadata.five-columns {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 0.9fr) minmax(0, 0.8fr);
    }
  }

  @container (min-width: 430px) and (max-width: 580px) {
    .artifact-library-row-metadata.five-columns {
      grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 0.9fr) minmax(0, 0.8fr);
    }
  }

  @container (max-width: 429px) {
    .artifact-library-row-metadata.five-columns {
      grid-template-columns: repeat(12, minmax(0, 1fr));
      column-gap: 0;
    }

    .artifact-library-row-metadata.five-columns > :nth-child(-n + 2) {
      grid-column: span 6;
    }

    .artifact-library-row-metadata.five-columns > :nth-child(3) {
      grid-column: span 5;
    }

    .artifact-library-row-metadata.five-columns > :nth-child(4) {
      grid-column: span 4;
    }

    .artifact-library-row-metadata.five-columns > :nth-child(5) {
      grid-column: span 3;
    }
  }
</style>
