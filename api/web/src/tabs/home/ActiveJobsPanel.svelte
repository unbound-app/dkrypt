<script lang="ts">
  import CopyButton from '../../components/CopyButton.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { liveState } from '../../lib/live.svelte';

  const jobs = $derived(liveState.overview?.activeJobs ?? []);
  const loaded = $derived(liveState.overview !== null);
</script>

<Card title="Active jobs">
  <div class="overflow-x-auto">
    <table class="min-w-[560px]">
      <thead>
        <tr>
          <th>Bundle ID</th>
          <th>Source</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Job ID</th>
        </tr>
      </thead>
      <tbody>
        {#if !loaded}
          <SkeletonRows rows={2} colspan={5} />
        {:else}
          {#each jobs as j (j.id)}
            <tr>
              <td class="max-w-40 truncate" title={j.bundleId}>{j.bundleId}</td>
              <td>{j.source}</td>
              <td><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
              <td class="max-w-52 text-muted">
                {#if j.status === 'running'}
                  <div class="flex items-center gap-2">
                    <div class="progress-indeterminate bg-border relative h-1 w-10 shrink-0 overflow-hidden rounded-full after:bg-accent"></div>
                    <span class="truncate" title={j.progress}>{j.progress}</span>
                  </div>
                {:else}
                  <span class="block truncate" title={j.progress}>{j.progress}</span>
                {/if}
              </td>
              <td>
                <div class="flex items-center gap-1.5">
                  <code title={j.id}>{j.id.slice(0, 8)}</code>
                  <CopyButton text={j.id} />
                </div>
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>
  {#if loaded && jobs.length === 0}
    <div class="text-sm text-muted">Nothing running.</div>
  {/if}
</Card>
