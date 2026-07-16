<script lang="ts">
  import { PackageOpen } from 'lucide-svelte';
  import CopyButton from '../../components/CopyButton.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { fetchJobEta } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { fmtDurationApprox } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { scrollFade } from '../../lib/scrollFade';

  const jobs = $derived(liveState.overview?.activeJobs ?? []);
  const loaded = $derived(liveState.overview !== null);

  let etaByBundle = $state<Record<string, number | null>>({});
  const fetchedBundles = new Set<string>();

  $effect(() => {
    for (const j of jobs) {
      if (j.status === 'running' && !fetchedBundles.has(j.bundleId)) {
        fetchedBundles.add(j.bundleId);
        void fetchJobEta(j.bundleId).then((r) => {
          etaByBundle[j.bundleId] = r.avgMs;
        });
      }
    }
  });
</script>

<Card title="Active jobs">
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
    <table class="min-w-[560px]">
      <thead>
        <tr>
          <th>Bundle ID</th>
          <th>Version</th>
          <th>Source</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Job ID</th>
        </tr>
      </thead>
      <tbody>
        {#if !loaded}
          <SkeletonRows rows={2} colspan={6} />
        {:else}
          {#each jobs as j (j.id)}
            <tr>
              <td class="max-w-40 truncate" title={j.bundleId}>{j.bundleId}</td>
              <td class="max-w-32 truncate" title={j.versionLabel}>
                {#if j.versionLabel}
                  {j.versionLabel}
                {:else}
                  <span class="text-muted">-</span>
                {/if}
                {#if j.testflight}
                  <Badge variant="secondary">TF</Badge>
                {/if}
              </td>
              <td>{j.source}</td>
              <td><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
              <td class="max-w-52 text-muted">
                {#if j.status === 'running'}
                  <div class="flex items-center gap-2">
                    <div class="progress-indeterminate bg-border relative h-1 w-10 shrink-0 overflow-hidden rounded-full after:bg-accent"></div>
                    <span class="truncate" title={j.progress}>{j.progress}</span>
                  </div>
                  {#if etaByBundle[j.bundleId]}
                    <div class="mt-0.5 text-[11px] text-muted">usually {fmtDurationApprox(etaByBundle[j.bundleId] as number)}</div>
                  {/if}
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
    <EmptyState icon={PackageOpen} message="Nothing running." />
  {/if}
</Card>
