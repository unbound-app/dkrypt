<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchProjects, type ProjectRecord } from '#lib/api';
  import Select from '#lib/components/ui/Select.svelte';
  import { projectSelectionState, setProjectSelection } from '#lib/projectSelection.svelte';
  import { reconnectLive } from '#lib/live.svelte';

  let projects = $state<ProjectRecord[] | null>(null);
  const items = $derived((projects ?? []).map((project) => ({ value: project.id, label: project.name })));

  onMount(() => {
    const refreshProjects = () => void loadProjects();
    window.addEventListener('dkrypt:projects-changed', refreshProjects);
    void loadProjects();

    return () => window.removeEventListener('dkrypt:projects-changed', refreshProjects);
  });

  async function loadProjects(): Promise<void> {
    try {
      const response = await fetchProjects();
      projects = response.projects.filter((project) => project.archivedAt === undefined);
      if (!projects.some((project) => project.id === projectSelectionState.id)) {
        setProjectSelection('default');
        reconnectLive(true);
      }
    } catch {
      projects = null;
    }
  }

  function selectProject(id: string): void {
    if (id === projectSelectionState.id) return;
    setProjectSelection(id);
    reconnectLive(true);
  }
</script>

{#if projects && projects.length > 1}
  <div class="border-border/70 bg-card/70 flex flex-wrap items-center justify-between gap-3 rounded-xl border px-3 py-2.5 sm:px-4">
    <div class="min-w-0">
      <label for="active-project" class="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Project</label>
      <div class="text-xs text-muted-foreground">Jobs and artifacts are shared with project members.</div>
    </div>
    <Select
      id="active-project"
      class="min-w-44 max-w-full"
      value={projectSelectionState.id}
      items={items}
      onValueChange={selectProject}
    />
  </div>
{/if}
