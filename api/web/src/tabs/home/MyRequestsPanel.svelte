<script lang="ts">
  import { PackageSearch } from 'lucide-svelte';
  import { fetchJobStatus, queueDecrypt, queueTestFlightDecrypt } from '../../lib/api';
  import EmptyState from '../../components/EmptyState.svelte';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { buttonVariants } from '../../lib/components/ui/variants';
  import { addDecrypt, dismissDecrypt, myDecryptsState, pushRecentBundleId, updateDecrypt, type TrackedDecrypt } from '../../lib/decrypts.svelte';
  import { showToast } from '../../lib/ui.svelte';

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
</script>

<Card title="My requests">
  {#if myDecryptsState.items.length === 0}
    <EmptyState icon={PackageSearch} message="Nothing queued yet - search above." />
  {:else}
    <table>
      <thead>
        <tr>
          <th>App</th>
          <th>Status</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each myDecryptsState.items as d (d.id)}
          <tr>
            <td>
              {d.trackName}
              {#if d.versionLabel}
                <span class="text-muted text-xs">({d.versionLabel})</span>
              {/if}
            </td>
            <td>
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
            <td>
              <div class="flex gap-1.5">
                {#if d.status === 'done'}
                  <a class={buttonVariants('default', 'sm')} href="/v1/dashboard/jobs/{d.id}/file">Download</a>
                  <Button size="sm" variant="secondary" onclick={() => dismissDecrypt(d.id)}>Dismiss</Button>
                {:else if d.status === 'failed'}
                  <Button size="sm" loading={retrying.has(d.id)} onclick={() => retry(d)}>Retry</Button>
                  <Button size="sm" variant="secondary" onclick={() => dismissDecrypt(d.id)}>Dismiss</Button>
                {:else}
                  <Button size="sm" variant="secondary" onclick={() => dismissDecrypt(d.id)}>Dismiss</Button>
                {/if}
              </div>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</Card>
