<script lang="ts">
  import { Activity, RefreshCw } from 'lucide-svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { fetchDashboardIncidents, type DashboardIncidentEvent } from '#lib/api';
  import { fmtTime } from '#lib/format.svelte';
  import { projectSelectionState } from '#lib/projectSelection.svelte';
  import { deviceDetailJumpState, jobDetailJumpState, logSearchJumpState, setActiveTab, setSettingsSubtab } from '#lib/ui.svelte';
  import { showToast } from '#lib/ui.svelte';

  let events = $state<DashboardIncidentEvent[]>([]);
  let loading = $state(false);
  let loaded = $state(false);
  let truncated = $state(false);
  let activeProject = '';

  async function load(): Promise<void> {
    loading = true;
    try {
      const result = await fetchDashboardIncidents(projectSelectionState.id);
      events = result.events;
      truncated = result.truncated;
      activeProject = result.projectId;
      loaded = true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not load the incident timeline', 'error');
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    const projectId = projectSelectionState.id;
    if (projectId !== activeProject) void load();
  });

  function openEvent(event: DashboardIncidentEvent): void {
    if (event.kind === 'job' && event.jobId) {
      jobDetailJumpState.id = event.jobId;
      setActiveTab('home');
      return;
    }
    if (event.kind === 'device' && event.deviceId) {
      deviceDetailJumpState.id = event.deviceId;
      setActiveTab('settings');
      setSettingsSubtab('devices');
      return;
    }
    if (event.deploymentId) {
      logSearchJumpState.value = { query: event.deploymentId, scope: 'deploy' };
      setActiveTab('logs');
    }
  }
</script>

<Card title="Incident timeline">
  {#snippet headerExtra()}
    <Button variant="ghost" size="icon" class="h-8 w-8" loading={loading} aria-label="Refresh incident timeline" onclick={() => void load()}><RefreshCw class="h-4 w-4" /></Button>
  {/snippet}
  {#if loading && !loaded}
    <div role="status" class="py-5 text-sm text-muted">Loading recent activity…</div>
  {:else if events.length === 0}
    <EmptyState icon={Activity} message="No recent incidents or activity for this project." />
  {:else}
    <ol class="divide-y divide-border/70">
      {#each events as event (event.id)}
        <li class="flex min-w-0 items-start gap-3 py-3 first:pt-0 last:pb-0">
          <time class="shrink-0 pt-0.5 font-mono text-[10px] text-muted" datetime={new Date(event.at).toISOString()}>{fmtTime(event.at)}</time>
          <Button variant="link" class="h-auto min-w-0 flex-1 justify-start whitespace-normal p-0 text-left" onclick={() => openEvent(event)}>
            <span class="block min-w-0"><span class="block text-xs font-medium">{event.title}</span>{#if event.detail}<span class="mt-0.5 block break-words text-[11px] text-muted" data-sensitive="true">{event.detail}</span>{/if}</span>
          </Button>
          <span class="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-[9px] uppercase text-muted">{event.kind}</span>
        </li>
      {/each}
    </ol>
    {#if truncated}<p class="mt-3 text-[11px] text-muted">Showing the latest 200 events.</p>{/if}
  {/if}
</Card>
