<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { liveState } from '../lib/live.svelte';
  import { PermissionFlag } from '../lib/permissions';
  import { sessionHasPermission } from '../lib/session.svelte';
  import { setActiveTab, setSettingsSubtab } from '../lib/ui.svelte';

  const issues = $derived((liveState.overview?.watches ?? []).flatMap((w) => w.configIssues));

  function goToScheduler(): void {
    setActiveTab('settings');
    setSettingsSubtab('scheduler');
  }
</script>

{#if sessionHasPermission(PermissionFlag.manageAutomation) && issues.length > 0}
  <div class="mb-4 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn">
    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      {#each issues as issue (issue)}
        <div>{issue}</div>
      {/each}
      <button class="mt-1.5 cursor-pointer underline underline-offset-2" onclick={goToScheduler}>Go to Automation settings</button>
    </div>
  </div>
{/if}
