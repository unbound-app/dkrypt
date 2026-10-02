<script lang="ts">
  import DonationNudge from '#components/DonationNudge.svelte';
  import ProjectSelector from '#components/ProjectSelector.svelte';
  import DecryptCompletion from '#components/DecryptCompletion.svelte';
  import OnboardingBanner from '#components/OnboardingBanner.svelte';
  import { batchDecryptJumpState, focusSearchJumpState } from '#lib/ui.svelte';
  import ArtifactLibrary from '#features/artifacts/ArtifactLibrary.svelte';
  import ActiveJobsPanel from '#features/jobs/ActiveJobsPanel.svelte';
  import DecryptPanel from '#features/jobs/DecryptPanel.svelte';
  import JobHistoryPanel from '#features/jobs/JobHistoryPanel.svelte';

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
  <ProjectSelector />
  <OnboardingBanner />
  <DecryptPanel bind:this={decryptPanel} />
  <DonationNudge />
  <ArtifactLibrary />
  <DecryptCompletion />
  <ActiveJobsPanel />
  <JobHistoryPanel />
</div>
