<script lang="ts">
  import CopyButton from './CopyButton.svelte';
  import { shareJobFile } from '../lib/api';
  import Button from '../lib/components/ui/Button.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import Select from '../lib/components/ui/Select.svelte';
  import { fmtUntil } from '../lib/format';

  let { open = $bindable(), jobId, onOpenChange }: { open: boolean; jobId: string; onOpenChange: (open: boolean) => void } = $props();

  const TTL_OPTIONS = [
    { value: '5', label: '5 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '360', label: '6 hours' },
    { value: '1440', label: '24 hours' },
  ];

  let ttlMinutes = $state('30');
  let url = $state('');
  let expiresAt = $state(0);
  let loading = $state(false);

  async function generate(): Promise<void> {
    loading = true;
    try {
      const { ok, data } = await shareJobFile(jobId, Number(ttlMinutes));
      if (!ok) return;
      url = data.url;
      expiresAt = data.expiresAt;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open) {
      url = '';
      void generate();
    }
  });
</script>

<Dialog {open} {onOpenChange} class="max-w-sm">
  <div class="mb-1 text-sm font-medium">Share download link</div>
  <div class="mb-3 text-xs text-muted">
    Anyone with this link can download the file without signing in - the first download consumes it, same as the button on this page.
  </div>
  <label for="share-ttl" class="mb-1 block text-xs text-muted">Expires</label>
  <Select id="share-ttl" items={TTL_OPTIONS} bind:value={ttlMinutes} class="w-full" onValueChange={generate} />
  {#if loading}
    <div class="mt-3 text-sm text-muted">Generating…</div>
  {:else if url}
    <div class="border-border bg-panel-muted mt-3 rounded-md border p-2.5 text-xs break-all">
      <code>{url}</code>
      <div class="mt-2 flex items-center justify-between gap-2">
        <CopyButton text={url} label="Copy link" />
        <span class="text-muted">expires in {fmtUntil(expiresAt)}</span>
      </div>
    </div>
  {/if}
  <Button variant="secondary" size="sm" class="mt-3 w-full" loading={loading} onclick={generate}>Regenerate</Button>
</Dialog>
