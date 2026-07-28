<script lang="ts">
  import CopyButton from '#components/CopyButton.svelte';
  import { fetchJobStatus, fetchShareLinks } from '#lib/api';
  import { appDisplayName } from '#lib/appCatalog.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { myDecryptsState, updateDecrypt, type TrackedDecrypt } from '#lib/decrypts.svelte';
  import { fmtUntil } from '#lib/format';
  import { notifyJobFinished } from '#lib/notifications';
  import { playChime, vibrateCompletion } from '#lib/sound';
  import { showToast, soundEnabledState } from '#lib/ui.svelte';

  interface CompletedDecrypt {
    label: string;
    url: string;
    expiresAt: number;
  }

  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let completed = $state<CompletedDecrypt[]>([]);
  const current = $derived(completed[0]);

  function decryptLabel(d: TrackedDecrypt): string {
    const name = appDisplayName(d.bundleId, d.trackName);
    return d.versionLabel ? `${name} (${d.versionLabel})` : name;
  }

  async function presentCompletion(d: TrackedDecrypt): Promise<void> {
    const links = await fetchShareLinks(d.id);
    const link = links.links.find((entry) => entry.url);
    const label = decryptLabel(d);

    if (!link?.url) {
      showToast(`${label} finished, but its share link is unavailable.`, 'error', { track: true });
      notifyJobFinished('Decrypt finished', `${label} is ready to download.`);
      return;
    }

    const url = link.url;
    completed = [...completed, { label, url, expiresAt: link.expiresAt }];
    notifyJobFinished('Decrypt finished', `${label} is ready to download.`, url);
    showToast(`${label} is ready to download.`, 'success', {
      track: true,
      downloadUrl: url,
      action: {
        label: 'Download',
        onClick: () => window.location.assign(url),
      },
    });
  }

  async function poll(): Promise<void> {
    clearTimeout(pollTimer);
    if (document.hidden) return;
    const pending = myDecryptsState.items.filter(
      (d) => d.status !== 'done' && d.status !== 'failed',
    );
    if (pending.length === 0) return;

    for (const d of pending) {
      try {
        const data = await fetchJobStatus(d.id);
        const finished = d.status !== data.status && (data.status === 'done' || data.status === 'failed');
        updateDecrypt(d.id, {
          status: data.status,
          progress: data.progress,
          queue: data.queue,
          error: data.error,
          fileExpiresAt: data.fileExpiresAt,
        });
        if (!finished) continue;
        if (soundEnabledState.value) {
          playChime();
          vibrateCompletion(data.status === 'done');
        }
        if (data.status === 'done') await presentCompletion(d);
        else {
          const label = decryptLabel(d);
          const message = `${label} failed: ${data.error ?? 'unknown error'}`;
          notifyJobFinished('Decrypt failed', message);
          showToast(message, 'error', { track: true });
        }
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

  function onOpenChange(open: boolean): void {
    if (!open) completed = completed.slice(1);
  }
</script>

<Dialog open={Boolean(current)} {onOpenChange} class="max-w-md">
  {#if current}
    <div class="mb-1 text-sm font-medium">Decrypt ready</div>
    <div class="mb-3 text-xs text-muted">
      {current.label} has a registered share link with unlimited downloads.
    </div>
    <div class="bg-panel-muted mb-4 flex items-center gap-2 rounded-lg p-2">
      <code class="min-w-0 flex-1 truncate" title={current.url}>{current.url}</code>
      <CopyButton text={current.url} label="Copy" />
    </div>
    <div class="mb-4 text-xs text-muted">Expires {fmtUntil(current.expiresAt)}. It is available in Share links.</div>
    <div class="flex gap-2">
      <a href={current.url} class="bg-accent text-accent-contrast hover:opacity-90 inline-flex h-8 flex-1 items-center justify-center rounded-md px-3 text-xs font-medium">Download</a>
      <Button variant="secondary" class="flex-1" onclick={() => onOpenChange(false)}>Close</Button>
    </div>
  {/if}
</Dialog>
