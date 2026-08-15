<script lang="ts">
  import CopyButton from '#components/CopyButton.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import { fetchJobStatus, fetchShareLinks, revokeAllShareLinks, revokeShareLink, shareJobFile, type ShareLinkRecord } from '#lib/api';
  import { updateDecrypt } from '#lib/decrypts.svelte';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { fmtUntil } from '#lib/format';
  import { confirmDialog } from '#lib/ui.svelte';

  let { open = $bindable(), jobId, onOpenChange }: { open: boolean; jobId: string; onOpenChange: (open: boolean) => void } = $props();

  const TTL_OPTIONS = [
    { value: '5', label: '5 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '360', label: '6 hours' },
    { value: '1440', label: '24 hours' },
  ];
  const MAX_DOWNLOAD_OPTIONS = [
    { value: '0', label: 'Unlimited' },
    { value: '1', label: '1 download' },
    { value: '3', label: '3 downloads' },
    { value: '5', label: '5 downloads' },
    { value: '10', label: '10 downloads' },
  ];
  const LAST_TTL_KEY = 'shareLinkLastTtlMinutes';
  const LAST_MAX_KEY = 'shareLinkLastMaxDownloads';
  const DEFAULT_TTL_MINUTES = '1440';
  const storedTtlMinutes = localStorage.getItem(LAST_TTL_KEY);

  let ttlMinutes = $state(storedTtlMinutes === null || storedTtlMinutes === '30' ? DEFAULT_TTL_MINUTES : storedTtlMinutes);
  let maxDownloads = $state(localStorage.getItem(LAST_MAX_KEY) ?? '0');
  let loading = $state(false);
  let links = $state<ShareLinkRecord[] | null>(null);
  let revoking = $state<Set<string>>(new Set());
  let revokingAll = $state(false);

  async function loadLinks(): Promise<void> {
    links = (await fetchShareLinks(jobId)).links;
  }

  async function syncJobExpiry(): Promise<void> {
    try {
      const data = await fetchJobStatus(jobId);
      updateDecrypt(jobId, { fileExpiresAt: data.fileExpiresAt });
    } catch {}
  }

  async function generate(): Promise<void> {
    loading = true;
    try {
      localStorage.setItem(LAST_TTL_KEY, ttlMinutes);
      localStorage.setItem(LAST_MAX_KEY, maxDownloads);
      const { ok } = await shareJobFile(jobId, Number(ttlMinutes), Number(maxDownloads));
      if (!ok) return;
      await loadLinks();
      void syncJobExpiry();
    } finally {
      loading = false;
    }
  }

  async function revokeAll(): Promise<void> {
    if (!(await confirmDialog(`Revoke ${activeCount} active share link(s)? Anyone holding one loses access immediately.`, { confirmLabel: 'Revoke all' }))) return;
    revokingAll = true;
    try {
      const { ok } = await revokeAllShareLinks(jobId);
      if (ok) {
        await loadLinks();
        void syncJobExpiry();
      }
    } finally {
      revokingAll = false;
    }
  }

  async function revoke(linkId: string): Promise<void> {
    if (!(await confirmDialog('Revoke this share link? It stops working immediately.'))) return;
    revoking = new Set(revoking).add(linkId);
    try {
      const { ok } = await revokeShareLink(linkId);
      if (ok) {
        await loadLinks();
        void syncJobExpiry();
      }
    } finally {
      const next = new Set(revoking);
      next.delete(linkId);
      revoking = next;
    }
  }

  $effect(() => {
    if (open) {
      links = null;
      void loadLinks();
    }
  });

  function linkStatus(l: ShareLinkRecord): 'active' | 'revoked' | 'expired' | 'exhausted' {
    if (l.revoked) return 'revoked';
    if (l.expiresAt <= Date.now()) return 'expired';
    if (l.maxDownloads !== undefined && l.downloadCount >= l.maxDownloads) return 'exhausted';
    return 'active';
  }

  function statusVariant(status: ReturnType<typeof linkStatus>): 'success' | 'destructive' | 'secondary' {
    if (status === 'active') return 'success';
    if (status === 'revoked') return 'destructive';
    return 'secondary';
  }

  function downloadsLabel(l: ShareLinkRecord): string {
    return l.maxDownloads !== undefined ? `${l.downloadCount}/${l.maxDownloads} downloads` : `${l.downloadCount} download${l.downloadCount === 1 ? '' : 's'}`;
  }

  const activeCount = $derived((links ?? []).filter((l) => linkStatus(l) === 'active').length);
</script>

<Dialog {open} {onOpenChange} class="max-w-md">
  <div class="mb-1 text-sm font-medium">Share download link</div>
  <div class="mb-3 text-xs text-muted">
    Anyone with the link can download it, no sign-in required, until it expires or reaches its download limit.
  </div>
  <div class="flex gap-2">
    <div class="flex-1">
      <label for="share-ttl" class="mb-1 block text-xs text-muted">Expires</label>
      <Select id="share-ttl" items={TTL_OPTIONS} bind:value={ttlMinutes} class="w-full" />
    </div>
    <div class="flex-1">
      <label for="share-max" class="mb-1 block text-xs text-muted">Downloads</label>
      <Select id="share-max" items={MAX_DOWNLOAD_OPTIONS} bind:value={maxDownloads} class="w-full" />
    </div>
  </div>
  <Button size="sm" class="mt-3 w-full" loading={loading} onclick={generate}>Create link</Button>

  {#if links && links.length > 0}
    <div class="border-border mt-4 border-t pt-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <span class="text-xs text-muted">Issued links for this job</span>
        {#if activeCount > 0}
          <Button size="sm" variant="destructive" loading={revokingAll} onclick={revokeAll}>Revoke {activeCount} active</Button>
        {/if}
      </div>
      <div class="flex flex-col gap-1.5">
        {#each links as l (l.id)}
          {@const status = linkStatus(l)}
          <div class="border-border flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge variant={statusVariant(status)}>{status}</Badge>
                <span class="text-muted">{downloadsLabel(l)}</span>
                <span class="text-muted">by {l.issuedBy}</span>
              </div>
              <div class="text-muted mt-0.5">
                <RelativeTime ms={l.issuedAt} /> · expires {fmtUntil(l.expiresAt)}
                {#if l.lastUsedAt}
                  · last used <RelativeTime ms={l.lastUsedAt} />
                {/if}
              </div>
              {#if l.url}
                <div class="mt-1.5 flex items-center gap-2">
                  <code class="min-w-0 flex-1 truncate rounded bg-panel-muted px-1.5 py-1" title={l.url}>{l.url}</code>
                  {#if status === 'active'}
                    <CopyButton text={l.url} label="Copy" />
                  {/if}
                </div>
              {/if}
            </div>
            {#if status === 'active'}
              <Button size="sm" variant="destructive" loading={revoking.has(l.id)} onclick={() => revoke(l.id)}>Revoke</Button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</Dialog>
