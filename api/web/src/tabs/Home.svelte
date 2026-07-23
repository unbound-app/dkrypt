<script lang="ts">
  import DonationNudge from '../components/DonationNudge.svelte';
  import OnboardingBanner from '../components/OnboardingBanner.svelte';
  import { batchDecryptJumpState } from '../lib/ui.svelte';
  import ActiveJobsPanel from './home/ActiveJobsPanel.svelte';
  import DecryptPanel from './home/DecryptPanel.svelte';
  import JobHistoryPanel from './home/JobHistoryPanel.svelte';
  import MyRequestsPanel from './home/MyRequestsPanel.svelte';

  let decryptPanel: DecryptPanel | undefined = $state();

  export function focusSearch(): void {
    decryptPanel?.focusSearch();
  }

  export function openBatch(): void {
    decryptPanel?.openBatch();
  }

  $effect(() => {
    if (batchDecryptJumpState.requested) {
      batchDecryptJumpState.requested = false;
      decryptPanel?.openBatch();
    }
  });
</script>

<div class="flex flex-col gap-4">
  <OnboardingBanner />
  <DecryptPanel bind:this={decryptPanel} />
  <DonationNudge />
  <div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
    <MyRequestsPanel />
    <ActiveJobsPanel />
  </div>
  <JobHistoryPanel />
</div>
