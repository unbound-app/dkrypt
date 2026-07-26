<script lang="ts">
  import { BarChart3, Command, FileClock, ListPlus, Search, ScrollText } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { openPalette, requestFocusSearch, requestOpenBatch, setActiveTab } from '#lib/ui.svelte';
  import { liveState } from '#lib/live.svelte';

  const canViewLogs = $derived(sessionHasPermission(PermissionFlag.viewLogs));
  const activeJobs = $derived(liveState.overview?.activeJobs.length ?? 0);

  function openJobActivity(): void {
    setActiveTab('home');
    requestAnimationFrame(() => document.getElementById(activeJobs > 0 ? 'active-jobs' : 'job-history')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
</script>

<nav class="border-border bg-panel-muted/50 flex flex-wrap items-center gap-1.5 rounded-xl border p-2" aria-label="Quick actions">
  <Button size="sm" onclick={requestFocusSearch}>
    <Search class="h-3.5 w-3.5" />
    Find app
  </Button>
  <Button size="sm" variant="secondary" onclick={requestOpenBatch}>
    <ListPlus class="h-3.5 w-3.5" />
    Batch decrypt
  </Button>
  <Button size="sm" variant="secondary" onclick={() => setActiveTab('insights')}>
    <BarChart3 class="h-3.5 w-3.5" />
    Insights
  </Button>
  <Button size="sm" variant="secondary" onclick={openJobActivity}>
    <FileClock class="h-3.5 w-3.5" />
    {activeJobs > 0 ? `${activeJobs} active` : 'Recent jobs'}
  </Button>
  {#if canViewLogs}
    <Button size="sm" variant="secondary" onclick={() => setActiveTab('logs')}>
      <ScrollText class="h-3.5 w-3.5" />
      Logs
    </Button>
  {/if}
  <Button size="sm" variant="secondary" onclick={openPalette}>
    <Command class="h-3.5 w-3.5" />
    Command menu
  </Button>
  <span class="ml-auto hidden items-center gap-1.5 pr-1 text-[11px] text-muted lg:inline-flex">
    Search with <kbd class="border-border rounded border px-1 font-mono">/</kbd>
  </span>
</nav>
