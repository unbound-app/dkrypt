<script lang="ts">
  import { PackageOpen } from 'lucide-svelte';
  import CopyButton from '../../components/CopyButton.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import SkeletonRows from '../../components/SkeletonRows.svelte';
  import { cancelJob, fetchJobEta, prioritizeJob } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { statusToBadgeVariant } from '../../lib/components/ui/variants';
  import { fmtDurationApprox } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { scrollFade } from '../../lib/scrollFade';
  import { sessionState } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  const jobs = $derived(liveState.overview?.activeJobs ?? []);
  const loaded = $derived(liveState.overview !== null);
  const canCancel = $derived(!!sessionState.permissions?.decrypt);

  let cancelling = $state<Set<string>>(new Set());
  let prioritizing = $state<Set<string>>(new Set());

  async function cancel(id: string, status: 'queued' | 'running'): Promise<void> {
    if (status === 'running' && !(await confirmDialog("Cancel this decrypt? It's already running on the device.", { confirmLabel: 'Cancel job' }))) {
      return;
    }
    cancelling = new Set(cancelling).add(id);
    try {
      await cancelJob(id);
    } finally {
      const next = new Set(cancelling);
      next.delete(id);
      cancelling = next;
    }
  }

  async function prioritize(id: string): Promise<void> {
    prioritizing = new Set(prioritizing).add(id);
    try {
      await prioritizeJob(id);
    } finally {
      const next = new Set(prioritizing);
      next.delete(id);
      prioritizing = next;
    }
  }

  const queuedJobIds = $derived(jobs.filter((j) => j.status === 'queued').map((j) => j.id));

  let etaByBundle = $state<Record<string, number | null>>({});
  const fetchedBundles = new Set<string>();

  $effect(() => {
    for (const j of jobs) {
      if (j.status === 'running' && !fetchedBundles.has(j.bundleId)) {
        fetchedBundles.add(j.bundleId);
        fetchJobEta(j.bundleId)
          .then((r) => {
            etaByBundle[j.bundleId] = r.avgMs;
          })
          .catch(() => {
            // Allow a retry on the next effect run instead of silently giving up on this bundle forever.
            fetchedBundles.delete(j.bundleId);
          });
      }
    }
  });
</script>

<Card title="Active jobs">
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
    <table class="responsive-table sm:min-w-[640px]">
      <thead>
        <tr>
          <th>Bundle ID</th>
          <th>Version</th>
          <th>Source</th>
          <th>Queued by</th>
          <th>Status</th>
          <th>Progress</th>
          <th>Job ID</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#if !loaded}
          <SkeletonRows rows={2} colspan={8} />
        {:else}
          {#each jobs as j (j.id)}
            <tr>
              <td data-label="Bundle ID" class="max-w-40 truncate" title={j.bundleId}>{j.bundleId}</td>
              <td data-label="Version" class="max-w-32">
                <div class="flex min-w-0 items-center gap-1" title={j.versionLabel}>
                  <span class="truncate">
                    {#if j.versionLabel}
                      {j.versionLabel}
                    {:else}
                      <span class="text-muted">-</span>
                    {/if}
                  </span>
                  {#if j.testflight}
                    <Badge variant="secondary" class="shrink-0">TF</Badge>
                  {/if}
                </div>
              </td>
              <td data-label="Source">{j.source}</td>
              <td data-label="Queued by" class="text-muted">{j.queuedBy ?? '-'}</td>
              <td data-label="Status"><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
              <td data-label="Progress" class="max-w-52 text-muted">
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
              <td data-label="Job ID">
                <div class="flex items-center gap-1.5">
                  <code title={j.id}>{j.id.slice(0, 8)}</code>
                  <CopyButton text={j.id} />
                </div>
              </td>
              <td>
                {#if canCancel && (j.status === 'queued' || j.status === 'running')}
                  <div class="flex justify-end gap-1.5">
                    {#if j.status === 'queued'}
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={prioritizing.has(j.id)}
                        disabled={queuedJobIds[0] === j.id}
                        onclick={() => prioritize(j.id)}
                      >
                        Bump to front
                      </Button>
                    {/if}
                    <Button size="sm" variant="destructive" loading={cancelling.has(j.id)} onclick={() => cancel(j.id, j.status)}>Cancel</Button>
                  </div>
                {/if}
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
