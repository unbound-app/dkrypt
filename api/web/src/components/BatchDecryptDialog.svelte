<script lang="ts">
  import { LoaderCircle } from 'lucide-svelte';
  import { queueDecrypt } from '../lib/api';
  import Button from '../lib/components/ui/Button.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import { addDecrypt, pushRecentBundleId } from '../lib/decrypts.svelte';
  import { requestNotificationPermission } from '../lib/notifications';
  import { showToast } from '../lib/ui.svelte';
  import { cn } from '../lib/utils';

  let { open = $bindable(), onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void } = $props();

  const MAX_BUNDLE_IDS = 50;
  const BUNDLE_ID_RE = /^[A-Za-z0-9.-]{3,200}$/;
  const EXTERNAL_VERSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  interface BatchEntry {
    bundleId: string;
    externalVersionId?: string;
  }

  let text = $state('');
  let submitting = $state(false);
  let results = $state<{ bundleId: string; externalVersionId?: string; state: 'pending' | 'ok' | 'error'; error?: string }[]>([]);

  function parseEntries(raw: string): BatchEntry[] {
    const seen = new Set<string>();
    const entries: BatchEntry[] = [];
    for (const line of raw.split(/[\n,]/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [bundleId, externalVersionId] = trimmed.split('@').map((s) => s.trim());
      const key = `${bundleId}@${externalVersionId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ bundleId, externalVersionId: externalVersionId || undefined });
      if (entries.length >= MAX_BUNDLE_IDS) break;
    }
    return entries;
  }

  const parsed = $derived(parseEntries(text));

  function close(): void {
    if (submitting) return;
    text = '';
    results = [];
    onOpenChange(false);
  }

  async function submitEntries(entries: BatchEntry[]): Promise<void> {
    requestNotificationPermission();
    submitting = true;

    let ok = 0;
    for (const entry of entries) {
      const { bundleId, externalVersionId } = entry;
      if (!BUNDLE_ID_RE.test(bundleId)) {
        results = results.map((r) => (r.bundleId === bundleId ? { ...r, state: 'error', error: "doesn't look like a bundle ID" } : r));
        continue;
      }
      if (externalVersionId && !EXTERNAL_VERSION_ID_RE.test(externalVersionId)) {
        results = results.map((r) => (r.bundleId === bundleId ? { ...r, state: 'error', error: 'invalid pinned version id' } : r));
        continue;
      }
      try {
        const { ok: queuedOk, data } = await queueDecrypt(bundleId, externalVersionId);
        if (!queuedOk) {
          results = results.map((r) => (r.bundleId === bundleId ? { ...r, state: 'error', error: 'rejected' } : r));
          continue;
        }
        addDecrypt({ id: data.id, bundleId, trackName: bundleId, externalVersionId, status: data.status, progress: data.progress, queue: data.queue });
        pushRecentBundleId(bundleId);
        results = results.map((r) => (r.bundleId === bundleId ? { ...r, state: 'ok' } : r));
        ok += 1;
      } catch {
        results = results.map((r) => (r.bundleId === bundleId ? { ...r, state: 'error', error: 'request failed' } : r));
      }
    }

    submitting = false;
    showToast(`Queued ${ok} of ${entries.length}${ok < entries.length ? ` - ${entries.length - ok} failed` : ''}`, ok === entries.length ? 'success' : 'error');
  }

  async function submit(): Promise<void> {
    const entries = parsed;
    if (entries.length === 0) return;
    results = entries.map((e) => ({ bundleId: e.bundleId, externalVersionId: e.externalVersionId, state: 'pending' }));
    await submitEntries(entries);
  }

  const failedCount = $derived(results.filter((r) => r.state === 'error').length);

  async function retryFailed(): Promise<void> {
    const failed = results.filter((r) => r.state === 'error').map((r) => ({ bundleId: r.bundleId, externalVersionId: r.externalVersionId }));
    if (failed.length === 0) return;
    results = results.map((r) => (r.state === 'error' ? { ...r, state: 'pending', error: undefined } : r));
    await submitEntries(failed);
  }
</script>

<Dialog {open} onOpenChange={(v) => !v && close()} class="max-w-md">
  <div class="mb-1 text-sm font-medium">Batch decrypt</div>
  <div class="mb-3 text-xs text-muted">
    One bundle ID per line, or comma-separated - optionally {'`bundleId@externalVersionId`'} to pin a specific release. Up to {MAX_BUNDLE_IDS} at
    once.
  </div>

  {#if results.length === 0}
    <textarea
      bind:value={text}
      disabled={submitting}
      placeholder={'com.example.app\ncom.example.app2@abc123\ncom.example.app3'}
      rows="6"
      class="border-border bg-panel-muted focus:border-accent w-full rounded-md border px-3 py-2 font-mono text-xs text-text focus:outline-none disabled:opacity-60"
    ></textarea>
    <div class="mt-1.5 text-xs text-muted">{parsed.length} bundle ID{parsed.length === 1 ? '' : 's'} recognized</div>
    <Button class="mt-3 w-full" disabled={parsed.length === 0} loading={submitting} onclick={submit}>Queue all</Button>
  {:else}
    <div class="flex max-h-72 flex-col gap-1 overflow-y-auto">
      {#each results as r (r.bundleId + (r.externalVersionId ?? ''))}
        <div class="flex items-center gap-2 text-xs">
          {#if r.state === 'pending'}
            <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin text-muted" />
          {:else if r.state === 'ok'}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-ok"></span>
          {:else}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-err"></span>
          {/if}
          <span class={cn('truncate font-mono', r.state === 'error' && 'text-err')}>
            {r.bundleId}{r.externalVersionId ? `@${r.externalVersionId}` : ''}
          </span>
          {#if r.error}<span class="text-muted">- {r.error}</span>{/if}
        </div>
      {/each}
    </div>
    <div class="mt-3 flex gap-2">
      {#if failedCount > 0}
        <Button class="flex-1" loading={submitting} onclick={retryFailed}>Retry {failedCount} failed</Button>
      {/if}
      <Button variant="secondary" class="flex-1" disabled={submitting} onclick={close}>Close</Button>
    </div>
  {/if}
</Dialog>
