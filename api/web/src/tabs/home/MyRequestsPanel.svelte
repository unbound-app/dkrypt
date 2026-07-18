<script lang="ts">
  import { PackageSearch } from 'lucide-svelte';
  import { cancelJob, fetchJobStatus, queueDecrypt, queueTestFlightDecrypt } from '../../lib/api';
  import CopyButton from '../../components/CopyButton.svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import ShareLinkDialog from '../../components/ShareLinkDialog.svelte';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { buttonVariants } from '../../lib/components/ui/variants';
  import {
    addDecrypt,
    dismissDecrypt,
    highlightJobIdState,
    myDecryptsState,
    pushRecentBundleId,
    updateDecrypt,
    type TrackedDecrypt,
  } from '../../lib/decrypts.svelte';
  import { notifyJobFinished } from '../../lib/notifications';
  import { playChime } from '../../lib/sound';
  import { showToast, soundEnabledState } from '../../lib/ui.svelte';

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retrying = $state<Set<string>>(new Set());

  async function poll(): Promise<void> {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    const pending = myDecryptsState.items.filter((d) => d.status !== 'done' && d.status !== 'failed');
    if (pending.length === 0) return;

    for (const d of pending) {
      try {
        const data = await fetchJobStatus(d.id);
        if (d.status !== data.status && (data.status === 'done' || data.status === 'failed')) {
          const label = d.versionLabel ? `${d.trackName} (${d.versionLabel})` : d.trackName;
          notifyJobFinished(
            data.status === 'done' ? 'Decrypt finished' : 'Decrypt failed',
            data.status === 'done' ? `${label} is ready to download.` : `${label} failed: ${data.error ?? 'unknown error'}`,
          );
          if (soundEnabledState.value) playChime();
        }
        updateDecrypt(d.id, { status: data.status, progress: data.progress, queue: data.queue, error: data.error });
      } catch {}
    }

    pollTimer = setTimeout(poll, 2500);
  }

  function onVisibilityChange(): void {
    if (!document.hidden) void poll();
  }

  $effect(() => {
    void poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearTimeout(pollTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  async function retry(d: TrackedDecrypt): Promise<void> {
    retrying = new Set(retrying).add(d.id);
    try {
      const { ok, data } = d.testflight
        ? await queueTestFlightDecrypt(d.bundleId, d.testflight.appId, d.testflight.build)
        : await queueDecrypt(d.bundleId, d.externalVersionId, d.versionLabel);
      if (!ok) return;
      addDecrypt({
        id: data.id,
        bundleId: d.bundleId,
        trackName: d.trackName,
        versionLabel: d.versionLabel,
        externalVersionId: d.externalVersionId,
        testflight: d.testflight,
        status: data.status,
        progress: data.progress,
        queue: data.queue,
      });
      pushRecentBundleId(d.bundleId);
      dismissDecrypt(d.id);
      showToast(`Queued ${d.trackName}${d.versionLabel ? ` (${d.versionLabel})` : ''}`, 'success');
    } finally {
      const next = new Set(retrying);
      next.delete(d.id);
      retrying = next;
    }
  }

  let shareOpen = $state(false);
  let shareJobId = $state('');

  function openShare(id: string): void {
    shareJobId = id;
    shareOpen = true;
  }

  let cancelling = $state<Set<string>>(new Set());

  async function cancel(d: TrackedDecrypt): Promise<void> {
    cancelling = new Set(cancelling).add(d.id);
    try {
      const { ok } = await cancelJob(d.id);
      if (ok) dismissDecrypt(d.id);
    } finally {
      const next = new Set(cancelling);
      next.delete(d.id);
      cancelling = next;
    }
  }

  // Dismiss only ever touches local myDecryptsState (the job itself keeps running server-side
  // either way, even for a still-in-flight one) - trivially and fully reversible, so an undo
  // toast replaces what used to be a confirm-dialog gate for the still-running case.
  function dismiss(d: TrackedDecrypt): void {
    dismissDecrypt(d.id);
    showToast('Dismissed', 'success', { action: { label: 'Undo', onClick: () => addDecrypt(d) } });
  }

  let highlightedId = $state<string | null>(null);

  $effect(() => {
    const id = highlightJobIdState.id;
    if (!id || !myDecryptsState.items.some((d) => d.id === id)) return;
    highlightedId = id;
    const row = document.querySelector(`[data-job-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => {
      highlightedId = null;
      if (highlightJobIdState.id === id) highlightJobIdState.id = null;
    }, 2000);
    return () => clearTimeout(timer);
  });

  const finishedCount = $derived(myDecryptsState.items.filter((d) => d.status === 'done' || d.status === 'failed').length);

  function clearFinished(): void {
    for (const d of myDecryptsState.items) {
      if (d.status === 'done' || d.status === 'failed') dismissDecrypt(d.id);
    }
  }
</script>

<Card title="My requests">
  {#snippet headerExtra()}
    {#if finishedCount > 0}
      <Button size="sm" variant="secondary" onclick={clearFinished}>Clear finished ({finishedCount})</Button>
    {/if}
  {/snippet}
  {#if myDecryptsState.items.length === 0}
    <EmptyState icon={PackageSearch} message="Nothing queued yet - search above." />
  {:else}
    <table class="responsive-table">
      <thead>
        <tr>
          <th>App</th>
          <th>Status</th>
          <th>Queued</th>
          <th>Job ID</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each myDecryptsState.items as d (d.id)}
          <tr data-job-id={d.id} class={d.id === highlightedId ? 'bg-accent/15 transition-colors duration-1000' : 'transition-colors duration-1000'}>
            <td data-label="App" class="max-w-40 truncate">
              {d.trackName}
              {#if d.versionLabel}
                <span class="text-muted text-xs">({d.versionLabel})</span>
              {/if}
            </td>
            <td data-label="Status">
              {#if d.status === 'done'}
                <Badge variant="success">done</Badge>
              {:else if d.status === 'failed'}
                <Badge variant="destructive">failed</Badge> <span class="text-muted">{d.error ?? ''}</span>
              {:else if d.status === 'running'}
                <Badge>running</Badge> <span class="text-muted">{d.progress ?? ''}</span>
              {:else}
                <Badge>queued</Badge>
                <span class="text-muted">{d.queue ? `position ${d.queue.position} of ${d.queue.total}` : ''}</span>
              {/if}
            </td>
            <td data-label="Queued" class="text-muted"><RelativeTime ms={d.createdAt} /></td>
            <td data-label="Job ID">
              <div class="flex items-center gap-1.5">
                <code title={d.id}>{d.id.slice(0, 8)}</code>
                <CopyButton text={d.id} />
              </div>
            </td>
            <td>
              <div class="flex flex-wrap justify-end gap-1.5">
                {#if d.status === 'done'}
                  <a class={buttonVariants('default', 'sm')} href="/v1/dashboard/jobs/{d.id}/file">Download</a>
                  <Button size="sm" variant="secondary" onclick={() => openShare(d.id)}>Share</Button>
                  <Button size="sm" variant="secondary" onclick={() => dismiss(d)}>Dismiss</Button>
                {:else if d.status === 'failed'}
                  <Button size="sm" loading={retrying.has(d.id)} onclick={() => retry(d)}>Retry</Button>
                  <Button size="sm" variant="secondary" onclick={() => dismiss(d)}>Dismiss</Button>
                {:else if d.status === 'queued'}
                  <Button size="sm" variant="destructive" loading={cancelling.has(d.id)} onclick={() => cancel(d)}>Cancel</Button>
                  <Button size="sm" variant="secondary" onclick={() => dismiss(d)}>Dismiss</Button>
                {:else}
                  <Button size="sm" variant="secondary" onclick={() => dismiss(d)}>Dismiss</Button>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Card>

<ShareLinkDialog open={shareOpen} jobId={shareJobId} onOpenChange={(v) => (shareOpen = v)} />
