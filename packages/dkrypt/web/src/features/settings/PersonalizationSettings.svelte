<script lang="ts">
  import { ArrowDown, ArrowUp, Pin, PinOff } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { artifactLibraryPreferencesState, displayTimeZoneState, largeTargetsState, navigationPreferencesState, type ArtifactColumnId, type TabId } from '#lib/ui.svelte';
  import { pushArtifactLibraryPreferences, pushDisplayTimeZonePref, pushLargeTargetsPref, pushNavigationPreferences } from '#lib/session.svelte';

  const tabLabels: Record<TabId, string> = {
    home: 'Home',
    billing: 'Plans',
    keys: 'API keys',
    logs: 'Logs',
    insights: 'Insights',
    docs: 'Docs',
    settings: 'Settings',
  };
  const columnLabels: Record<ArtifactColumnId, string> = {
    app: 'App name',
    bundleId: 'Bundle ID',
    version: 'Version',
    source: 'Source',
    size: 'Size',
    created: 'Added',
  };
  const timeZones = [...new Set([
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    'UTC',
    ...(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []),
  ])].sort((left, right) => left.localeCompare(right));

  function moveNavigation(index: number, offset: -1 | 1): void {
    const order = [...navigationPreferencesState.order];
    const target = index + offset;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target]!, order[index]!];
    void pushNavigationPreferences(order, navigationPreferencesState.pinned);
  }

  function togglePinned(id: TabId): void {
    const pinned = navigationPreferencesState.pinned.includes(id)
      ? navigationPreferencesState.pinned.filter((candidate) => candidate !== id)
      : [...navigationPreferencesState.pinned, id];
    void pushNavigationPreferences(navigationPreferencesState.order, pinned);
  }

  function toggleColumn(id: ArtifactColumnId): void {
    const columns = artifactLibraryPreferencesState.columns.includes(id)
      ? artifactLibraryPreferencesState.columns.filter((candidate) => candidate !== id)
      : [...artifactLibraryPreferencesState.columns, id];
    if (columns.length === 0) return;
    void pushArtifactLibraryPreferences(artifactLibraryPreferencesState.groupByApp, columns);
  }

  function moveColumn(id: ArtifactColumnId, offset: -1 | 1): void {
    const columns = [...artifactLibraryPreferencesState.columns];
    const index = columns.indexOf(id);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= columns.length) return;
    [columns[index], columns[target]] = [columns[target]!, columns[index]!];
    void pushArtifactLibraryPreferences(artifactLibraryPreferencesState.groupByApp, columns);
  }
</script>

<div class="grid gap-5 xl:grid-cols-2">
  <section class="rounded-xl border border-border/70 bg-panel/40 p-4">
    <h2 class="text-sm font-semibold">Display</h2>
    <label for="display-time-zone" class="mt-4 block text-xs font-medium">Dashboard time zone</label>
    <select
      id="display-time-zone"
      class="mt-1.5 min-h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
      value={displayTimeZoneState.value}
      onchange={(event) => void pushDisplayTimeZonePref(event.currentTarget.value)}
    >
      <option value="system">System local time</option>
      {#each timeZones as timeZone (timeZone)}<option value={timeZone}>{timeZone}</option>{/each}
    </select>
    <label class="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm">
      <span>Larger touch targets</span>
      <input type="checkbox" class="size-5 accent-accent" checked={largeTargetsState.value} onchange={(event) => void pushLargeTargetsPref(event.currentTarget.checked)} />
    </label>
  </section>

  <section class="rounded-xl border border-border/70 bg-panel/40 p-4">
    <h2 class="text-sm font-semibold">Artifact Library</h2>
    <label class="mt-4 flex min-h-11 items-center justify-between gap-3 text-sm">
      <span>Group versions by app</span>
      <input type="checkbox" class="size-5 accent-accent" checked={artifactLibraryPreferencesState.groupByApp} onchange={(event) => void pushArtifactLibraryPreferences(event.currentTarget.checked, artifactLibraryPreferencesState.columns)} />
    </label>
    <div class="mt-3 text-xs font-medium text-muted">Visible columns</div>
    <div class="mt-1 divide-y divide-border/70">
        {#each Object.entries(columnLabels) as [id, label] (id)}
          <label class="flex min-h-10 items-center gap-3 text-sm">
            <input type="checkbox" class="size-4 accent-accent" checked={artifactLibraryPreferencesState.columns.includes(id as ArtifactColumnId)} disabled={artifactLibraryPreferencesState.columns.length === 1 && artifactLibraryPreferencesState.columns[0] === id} onchange={() => toggleColumn(id as ArtifactColumnId)} />
            <span class="min-w-0 flex-1">{label}</span>
            {#if artifactLibraryPreferencesState.columns.includes(id as ArtifactColumnId)}
              {@const columnIndex = artifactLibraryPreferencesState.columns.indexOf(id as ArtifactColumnId)}
              <Button variant="ghost" size="icon" class="h-8 w-8" aria-label="Move {label} column earlier" disabled={columnIndex === 0} onclick={() => moveColumn(id as ArtifactColumnId, -1)}><ArrowUp class="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" class="h-8 w-8" aria-label="Move {label} column later" disabled={columnIndex === artifactLibraryPreferencesState.columns.length - 1} onclick={() => moveColumn(id as ArtifactColumnId, 1)}><ArrowDown class="h-3.5 w-3.5" /></Button>
            {/if}
          </label>
        {/each}
    </div>
  </section>

  <section class="rounded-xl border border-border/70 bg-panel/40 p-4 xl:col-span-2">
    <h2 class="text-sm font-semibold">Navigation</h2>
    <p class="mt-1 text-xs text-muted">Pin frequently used pages and arrange their order.</p>
    <ol class="mt-3 divide-y divide-border/70">
      {#each navigationPreferencesState.order as id, index (id)}
        <li class="flex min-h-12 items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-sm">{tabLabels[id]}</span>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label="Move {tabLabels[id]} earlier" disabled={index === 0} onclick={() => moveNavigation(index, -1)}><ArrowUp class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label="Move {tabLabels[id]} later" disabled={index === navigationPreferencesState.order.length - 1} onclick={() => moveNavigation(index, 1)}><ArrowDown class="h-4 w-4" /></Button>
          <Button variant="ghost" size="icon" class="h-10 w-10" aria-label={navigationPreferencesState.pinned.includes(id) ? `Unpin ${tabLabels[id]}` : `Pin ${tabLabels[id]}`} aria-pressed={navigationPreferencesState.pinned.includes(id)} onclick={() => togglePinned(id)}>
            {#if navigationPreferencesState.pinned.includes(id)}<PinOff class="h-4 w-4" />{:else}<Pin class="h-4 w-4" />{/if}
          </Button>
        </li>
      {/each}
    </ol>
  </section>
</div>
