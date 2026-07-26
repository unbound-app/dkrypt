<script lang="ts">
  import { GripVertical, PackageOpen } from 'lucide-svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import SkeletonRows from '#components/SkeletonRows.svelte';
  import { cancelJob, fetchJobEta, prioritizeJob, reorderQueue, type ActiveJob } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import { statusToBadgeVariant } from '#lib/components/ui/variants';
  import { fmtDurationApprox } from '#lib/format';
  import { liveState } from '#lib/live.svelte';
  import { scrollFade } from '#lib/scrollFade';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { confirmDialog, densityState, requestFocusSearch } from '#lib/ui.svelte';

  const jobs = $derived(liveState.overview?.activeJobs ?? []);
  const loaded = $derived(liveState.overviewLoaded);
  const canCancel = $derived(sessionHasPermission(PermissionFlag.requestDecrypt));

  let cancelling = $state<Set<string>>(new Set());
  let prioritizing = $state<Set<string>>(new Set());
  let selected = $state<Set<string>>(new Set());
  let bulkCancelling = $state(false);
  let bulkPrioritizing = $state(false);
  let revealedJobIds = $state<Set<string>>(new Set());

  function toggleReveal(id: string): void {
    const next = new Set(revealedJobIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    revealedJobIds = next;
  }

  $effect(() => {
    const liveIds = new Set(jobs.map((j) => j.id));
    if ([...selected].some((id) => !liveIds.has(id))) {
      selected = new Set([...selected].filter((id) => liveIds.has(id)));
    }
  });

  function toggleSelect(id: string): void {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selected = next;
  }

  function toggleSelectAll(): void {
    selected = selected.size === jobs.length ? new Set() : new Set(jobs.map((j) => j.id));
  }

  async function bulkCancel(): Promise<void> {
    const ids = [...selected];
    if (ids.length === 0) return;
    const runningCount = jobs.filter((j) => ids.includes(j.id) && j.status === 'running').length;
    const message =
      runningCount > 0
        ? `Cancel ${ids.length} selected job(s)? ${runningCount} of them ${runningCount === 1 ? 'is' : 'are'} already running on the device.`
        : `Cancel ${ids.length} selected job(s)?`;
    if (!(await confirmDialog(message, { confirmLabel: 'Cancel jobs' }))) return;
    bulkCancelling = true;
    try {
      await Promise.all(ids.map((id) => cancelJob(id)));
      selected = new Set();
    } finally {
      bulkCancelling = false;
    }
  }

  async function bulkPrioritize(): Promise<void> {
    const ids = [...selected].filter((id) => jobs.find((j) => j.id === id)?.status === 'queued');
    if (ids.length === 0) return;
    bulkPrioritizing = true;
    try {
      await Promise.all(ids.map((id) => prioritizeJob(id)));
    } finally {
      bulkPrioritizing = false;
    }
  }

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

  let draggingId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);

  function onRowDragStart(j: ActiveJob): void {
    if (j.status !== 'queued') return;
    draggingId = j.id;
  }

  function onRowDragOver(e: DragEvent, j: ActiveJob): void {
    if (!draggingId || j.status !== 'queued' || j.id === draggingId) return;
    e.preventDefault();
    dragOverId = j.id;
  }

  function onRowDrop(e: DragEvent, target: ActiveJob): void {
    e.preventDefault();
    const dragged = draggingId;
    draggingId = null;
    dragOverId = null;
    if (!dragged || target.status !== 'queued' || dragged === target.id) return;

    const next = [...queuedJobIds];
    const from = next.indexOf(dragged);
    const to = next.indexOf(target.id);
    if (from === -1 || to === -1) return;
    next.splice(from, 1);
    next.splice(to, 0, dragged);
    void reorderQueue(next);
  }

  function onRowDragEnd(): void {
    draggingId = null;
    dragOverId = null;
  }

  let etaByBundle = $state<Record<string, number | null>>({});
  const fetchedBundles = new Set<string>();

  $effect(() => {
    for (const j of jobs) {
      if (!fetchedBundles.has(j.bundleId)) {
        fetchedBundles.add(j.bundleId);
        fetchJobEta(j.bundleId)
          .then((r) => {
            etaByBundle[j.bundleId] = r.avgMs;
          })
          .catch(() => {

            fetchedBundles.delete(j.bundleId);
          });
      }
    }
  });

  const queueEtaMs = $derived.by(() => {
    let total = 0;
    let known = false;
    for (const j of jobs) {
      const avg = etaByBundle[j.bundleId];
      if (avg) {
        total += avg;
        known = true;
      }
    }
    return known ? total : null;
  });
</script>

<Card title="Active jobs">
  {#snippet headerExtra()}
    {#if canCancel && selected.size > 0}
      <div class="flex flex-wrap items-center gap-1.5">
        <Button size="sm" variant="secondary" loading={bulkPrioritizing} onclick={bulkPrioritize}>Bump queued to front</Button>
        <Button size="sm" variant="destructive" loading={bulkCancelling} onclick={bulkCancel}>Cancel {selected.size} selected</Button>
      </div>
    {:else if jobs.length > 1 && queueEtaMs !== null}
      <span class="text-xs text-muted" title="Sum of each queued/running job's own average duration">
        Queue clears in {fmtDurationApprox(queueEtaMs)}
      </span>
    {/if}
  {/snippet}
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade>
    <table class="responsive-table xl:min-w-[980px]">
      <thead>
        <tr>
          {#if canCancel}
            <th></th>
            <th><input type="checkbox" checked={jobs.length > 0 && selected.size === jobs.length} onchange={toggleSelectAll} aria-label="Select all active jobs" /></th>
          {/if}
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
          <SkeletonRows rows={2} colspan={canCancel ? 10 : 8} />
        {:else}
          {#each jobs as j (j.id)}
            <tr
              class={dragOverId === j.id ? 'bg-accent/10' : ''}
              draggable={canCancel && j.status === 'queued'}
              ondragstart={() => onRowDragStart(j)}
              ondragover={(e) => onRowDragOver(e, j)}
              ondrop={(e) => onRowDrop(e, j)}
              ondragend={onRowDragEnd}
            >
              {#if canCancel}
                <td class="mobile-drag cursor-grab active:cursor-grabbing">
                  {#if j.status === 'queued'}
                    <GripVertical class="text-muted h-3.5 w-3.5" />
                  {/if}
                </td>
                <td data-label="Select"><input type="checkbox" checked={selected.has(j.id)} onchange={() => toggleSelect(j.id)} /></td>
              {/if}
              <td data-label="Bundle ID" class="max-w-40 truncate font-mono text-[11px]" title={j.bundleId}>{j.bundleId}</td>
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
              <td data-label="Queued by" class="text-muted">
                {j.queuedBy ?? '-'}
                {#if j.priority}
                  <Badge variant="secondary" class="ml-1" title="Queue priority">{j.priority > 0 ? '+' : ''}{j.priority}</Badge>
                {/if}
              </td>
              <td data-label="Status"><Badge variant={statusToBadgeVariant(j.status)}>{j.status}</Badge></td>
              <td data-label="Progress" class="min-w-72 max-w-md text-muted">
                {#if j.status === 'running'}
                  <div class="flex w-full items-start gap-2">
                    <div class="progress-indeterminate bg-border relative h-1 w-10 shrink-0 overflow-hidden rounded-full after:bg-accent"></div>
                    <div class="min-w-0 flex-1">
                      <p class="break-words text-left text-xs leading-5 text-text" title={j.progress}>{j.progress}</p>
                      {#if etaByBundle[j.bundleId]}
                        <p class="mt-0.5 text-left text-[11px] text-muted">usually {fmtDurationApprox(etaByBundle[j.bundleId] as number)}</p>
                      {/if}
                    </div>
                  </div>
                {:else}
                  <p class="break-words text-left text-xs leading-5" title={j.progress}>{j.progress}</p>
                {/if}
              </td>
              <td data-label="Job ID">
                {#if densityState.value === 'compact' && !revealedJobIds.has(j.id)}
                  <button
                    class="text-muted hover:text-text cursor-pointer text-xs underline-offset-2 hover:underline"
                    onclick={() => toggleReveal(j.id)}
                  >
                    show
                  </button>
                {:else}
                  <div class="flex items-center gap-1.5">
                    <code title={j.id}>{j.id.slice(0, 8)}</code>
                    <CopyButton text={j.id} />
                  </div>
                {/if}
              </td>
              <td data-label="Actions" class="mobile-actions">
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
    <EmptyState icon={PackageOpen} message="Nothing running.">
      {#snippet action()}
        <Button size="sm" variant="secondary" onclick={() => requestFocusSearch()}>Queue a decrypt</Button>
      {/snippet}
    </EmptyState>
  {/if}
</Card>
