<script lang="ts">
  import { compareDashboardArtifacts, type ArtifactStructureComparison } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { appDisplayName } from '#lib/appCatalog.svelte';
  import { fmtSize } from '#lib/format.svelte';

  let { open = $bindable(), ids }: { open: boolean; ids: [string, string] } = $props();
  let result = $state<ArtifactStructureComparison | null>(null);
  let loading = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) return;
    result = null;
    error = '';
    loading = true;
    void compareDashboardArtifacts(ids).then((comparison) => {
      result = comparison;
    }).catch((cause) => {
      error = cause instanceof Error ? cause.message : 'Could not compare these IPA files';
    }).finally(() => {
      loading = false;
    });
  });
</script>

<Dialog bind:open title="Compare IPA contents" class="max-h-[85dvh] max-w-3xl overflow-y-auto">
  <div class="mb-4 flex items-start justify-between gap-3">
    <div><h2 class="text-base font-semibold">Compare IPA contents</h2><p class="text-muted mt-1 text-xs">Package paths, file sizes, and archive checksums are compared. File contents are not exposed.</p></div>
    <Button size="sm" variant="secondary" onclick={() => (open = false)}>Close</Button>
  </div>
  {#if loading}<div role="status" class="text-sm text-muted">Reading package directories…</div>
  {:else if error}<div role="alert" class="text-sm text-err">{error}</div>
  {:else if result}
    <div class="grid gap-2 sm:grid-cols-2">
      <div class="rounded-lg border border-border/70 p-3"><div class="text-xs text-muted">Before</div><div class="mt-1 truncate text-sm font-semibold">{appDisplayName(result.before.bundleId)}</div><div class="mt-1 flex justify-between gap-2 text-xs"><span>{result.before.versionLabel ?? 'Version unavailable'}</span><span>{fmtSize(result.before.fileSizeBytes)}</span></div></div>
      <div class="rounded-lg border border-border/70 p-3"><div class="text-xs text-muted">After</div><div class="mt-1 truncate text-sm font-semibold">{appDisplayName(result.after.bundleId)}</div><div class="mt-1 flex justify-between gap-2 text-xs"><span>{result.after.versionLabel ?? 'Version unavailable'}</span><span>{fmtSize(result.after.fileSizeBytes)}</span></div></div>
    </div>
    <div class="my-4 flex flex-wrap gap-2">
      <Badge variant="secondary">{result.counts.added} added</Badge><Badge variant="secondary">{result.counts.removed} removed</Badge><Badge variant="secondary">{result.counts.changed} changed</Badge><Badge variant="outline">{result.counts.unchanged} unchanged</Badge>
    </div>
    {#if result.truncated}<p class="mb-2 text-xs text-muted">Showing the first 200 changes in each category.</p>{/if}
    <div class="space-y-3">
      {#each [{ label: 'Added files', entries: result.added }, { label: 'Removed files', entries: result.removed }] as section (section.label)}
        {#if section.entries.length > 0}<section><h3 class="mb-1 text-xs font-semibold">{section.label}</h3><ul class="max-h-40 overflow-auto rounded-md border border-border/70 font-mono text-[11px]">{#each section.entries as entry (entry)}<li class="break-all border-b border-border/50 px-2 py-1 last:border-0">{entry}</li>{/each}</ul></section>{/if}
      {/each}
      {#if result.changed.length > 0}<section><h3 class="mb-1 text-xs font-semibold">Changed files</h3><ul class="max-h-52 overflow-auto rounded-md border border-border/70 font-mono text-[11px]">{#each result.changed as entry (entry.path)}<li class="break-all border-b border-border/50 px-2 py-1 last:border-0"><div>{entry.path}</div><div class="mt-0.5 text-muted">{fmtSize(entry.beforeBytes)} → {fmtSize(entry.afterBytes)}</div></li>{/each}</ul></section>{/if}
    </div>
  {/if}
</Dialog>
