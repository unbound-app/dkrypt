<script lang="ts">
  import DonationNudge from '#components/DonationNudge.svelte';
  import DecryptCompletion from '#components/DecryptCompletion.svelte';
  import OnboardingBanner from '#components/OnboardingBanner.svelte';
  import { batchDecryptJumpState, focusSearchJumpState } from '#lib/ui.svelte';
  import ActiveJobsPanel from '#tabs/home/ActiveJobsPanel.svelte';
  import DecryptPanel from '#tabs/home/DecryptPanel.svelte';
  import JobHistoryPanel from '#tabs/home/JobHistoryPanel.svelte';

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

  $effect(() => {
    if (focusSearchJumpState.requested) {
      focusSearchJumpState.requested = false;
      decryptPanel?.focusSearch();
    }
  });
</script>

<div class="flex flex-col gap-4">
  <OnboardingBanner />
  <DecryptPanel bind:this={decryptPanel} />
  <DonationNudge />
  <DecryptCompletion />
  <ActiveJobsPanel />
  <JobHistoryPanel />
</div>
