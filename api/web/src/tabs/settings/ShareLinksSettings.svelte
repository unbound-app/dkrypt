<script lang="ts">
  import { RefreshCw } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import CopyButton from '#components/CopyButton.svelte';
  import EmptyState from '#components/EmptyState.svelte';
  import RelativeTime from '#components/RelativeTime.svelte';
  import { fetchAllShareLinks, revokeShareLink, updateShareLink, type ShareLinkRecord } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Select from '#lib/components/ui/Select.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';

  let allLinks = $state<ShareLinkRecord[] | null>(null);
  let loading = $state(false);
  let revoking = $state<Set<string>>(new Set());
  let saving = $state(false);

  let manageOpen = $state(false);
  let manageLink = $state<ShareLinkRecord | null>(null);
  let manageTtl = $state('30');
  let manageMaxDownloads = $state('0');

  const canExtend = $derived(sessionHasPermission(PermissionFlag.extendShareLinks));

  const links = $derived((allLinks ?? []).filter((l) => !l.revoked));

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

  async function load(): Promise<void> {
    loading = true;
    try {
      allLinks = (await fetchAllShareLinks()).links;
    } finally {
      loading = false;
    }
  }

  async function revoke(linkId: string): Promise<void> {
    revoking = new Set(revoking).add(linkId);
    try {
      const { ok } = await revokeShareLink(linkId);
      if (ok) await load();
    } finally {
      const next = new Set(revoking);
      next.delete(linkId);
      revoking = next;
    }
  }

  onMount(load);

  function linkStatus(l: ShareLinkRecord): 'active' | 'expired' | 'exhausted' {
    if (l.expiresAt <= Date.now()) return 'expired';
    if (l.maxDownloads !== undefined && l.downloadCount >= l.maxDownloads) return 'exhausted';
    return 'active';
  }

  function statusVariant(status: ReturnType<typeof linkStatus>): 'success' | 'secondary' {
    return status === 'active' ? 'success' : 'secondary';
  }

  function downloadsLabel(l: ShareLinkRecord): string {
    return l.maxDownloads !== undefined ? `${l.downloadCount}/${l.maxDownloads}` : `${l.downloadCount}`;
  }

  function ttlOptionsFor(l: ShareLinkRecord): typeof TTL_OPTIONS {
    if (canExtend) return TTL_OPTIONS;
    const remainingMin = Math.floor((l.expiresAt - Date.now()) / 60_000);
    return TTL_OPTIONS.filter((o) => Number(o.value) <= remainingMin);
  }

  const manageTtlOptions = $derived(manageLink ? ttlOptionsFor(manageLink) : []);

  function openManage(l: ShareLinkRecord): void {
    manageLink = l;
    manageTtl = ttlOptionsFor(l).at(-1)?.value ?? TTL_OPTIONS[0].value;
    manageMaxDownloads = String(l.maxDownloads ?? 0);
    manageOpen = true;
  }

  async function saveManage(): Promise<void> {
    if (!manageLink) return;
    saving = true;
    try {
      const maxDownloadsValue = Number(manageMaxDownloads);
      const { ok } = await updateShareLink(manageLink.id, {
        ttlMinutes: Number(manageTtl),
        maxDownloads: maxDownloadsValue > 0 ? maxDownloadsValue : null,
      });
      if (ok) {
        manageOpen = false;
        await load();
      }
    } finally {
      saving = false;
    }
  }
</script>

<Card title="Share links">
  {#snippet headerExtra()}
    <button
      type="button"
      class="text-muted hover:text-text disabled:opacity-50"
      disabled={loading}
      onclick={load}
      aria-label="Refresh"
      title="Refresh"
    >
      <RefreshCw class="h-3.5 w-3.5 {loading ? 'animate-spin' : ''}" />
    </button>
  {/snippet}
  <div class="mb-3 text-xs text-muted">Every active download share link issued across all jobs. Revoked links are hidden. Copy, manage, or revoke any of them.</div>

  {#if allLinks && links.length === 0}
    <EmptyState message="No share links have been issued." />
  {:else if allLinks}
    <div class="flex flex-col gap-2">
      {#each links as l (l.id)}
        {@const status = linkStatus(l)}
        <div class="border-border rounded-md border px-3 py-2.5 text-xs">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-1.5">
                <Badge variant={statusVariant(status)}>{status}</Badge>
                <span class="truncate font-mono" title={l.bundleId}>{l.bundleId}</span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                <span>{downloadsLabel(l)} downloads</span>
                <span>by {l.issuedBy}</span>
              </div>
              <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                <span>issued <RelativeTime ms={l.issuedAt} /></span>
                {#if status === 'expired'}
                  <span>expired <RelativeTime ms={l.expiresAt} /></span>
                {:else}
                  <span>expires <RelativeTime ms={l.expiresAt} /></span>
                {/if}
                {#if l.lastUsedAt}
                  <span>last used <RelativeTime ms={l.lastUsedAt} /></span>
                {/if}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <Button size="sm" variant="secondary" onclick={() => openManage(l)}>Manage</Button>
              <Button size="sm" variant="destructive" loading={revoking.has(l.id)} onclick={() => revoke(l.id)}>Revoke</Button>
            </div>
          </div>

          {#if l.url}
            <div class="mt-2 flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate rounded bg-panel-muted px-1.5 py-1" title={l.url}>{l.url}</code>
              <CopyButton text={l.url} label="Copy" />
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</Card>

<Dialog open={manageOpen} onOpenChange={(v) => (manageOpen = v)} class="max-w-md">
  {#if manageLink}
    <div class="mb-1 text-sm font-medium">Manage share link</div>
    <div class="mb-3 truncate font-mono text-xs text-muted" title={manageLink.bundleId}>{manageLink.bundleId}</div>
    <div class="flex gap-2">
      <div class="flex-1">
        <div class="mb-1 text-xs text-muted">New expiry</div>
        {#if manageTtlOptions.length > 0}
          <Select items={manageTtlOptions} bind:value={manageTtl} class="w-full" />
        {:else}
          <div class="text-xs text-muted italic">no shorter option available</div>
        {/if}
      </div>
      <div class="flex-1">
        <div class="mb-1 text-xs text-muted">Downloads</div>
        <Select items={MAX_DOWNLOAD_OPTIONS} bind:value={manageMaxDownloads} class="w-full" />
      </div>
    </div>
    {#if !canExtend}
      <div class="mt-2 text-xs text-muted italic">Only expiry times shorter than the current one are available without the extend permission.</div>
    {/if}
    <div class="mt-4 flex gap-2">
      <Button class="flex-1" loading={saving} disabled={manageTtlOptions.length === 0} onclick={saveManage}>Save</Button>
      <Button variant="secondary" class="flex-1" onclick={() => (manageOpen = false)}>Cancel</Button>
    </div>
  {/if}
</Dialog>
