<script lang="ts">
  import ActiveJobsPanel from './home/ActiveJobsPanel.svelte';
  import DecryptPanel from './home/DecryptPanel.svelte';
  import JobHistoryPanel from './home/JobHistoryPanel.svelte';
  import MyRequestsPanel from './home/MyRequestsPanel.svelte';
  import StatusPanel from './home/StatusPanel.svelte';

  let decryptPanel: DecryptPanel | undefined = $state();

  export function focusSearch(): void {
    decryptPanel?.focusSearch();
  }
</script>

<div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
  <div class="flex flex-col gap-4">
    <DecryptPanel bind:this={decryptPanel} />
    <MyRequestsPanel />
    <ActiveJobsPanel />
    <JobHistoryPanel />
  </div>
  <div class="flex flex-col gap-4">
    <StatusPanel />
  </div>
</div>
