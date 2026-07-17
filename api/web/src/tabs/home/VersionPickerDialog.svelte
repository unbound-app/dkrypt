<script lang="ts">
  import { fetchAppVersions, type AppVersionEntry } from '../../lib/api';
  import Badge from '../../lib/components/ui/Badge.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Dialog from '../../lib/components/ui/Dialog.svelte';
  import { fmtTime } from '../../lib/format';

  interface Props {
    open: boolean;
    bundleId: string;
    trackName: string;
    onOpenChange: (open: boolean) => void;
    onDecrypt: (bundleId: string, externalVersionId: string, label: string) => void;
  }

  let { open, bundleId, trackName, onOpenChange, onDecrypt }: Props = $props();

  let versions = $state<AppVersionEntry[] | null>(null);
  let error = $state('');
  let loadedFor = $state('');

  function load(id: string): void {
    loadedFor = id;
    versions = null;
    error = '';
    fetchAppVersions(id)
      .then((data) => {
        if ('error' in data) {
          error = data.error;
          versions = [];
        } else {
          versions = data.versions;
        }
      })
      .catch(() => {
        error = 'Failed to load version history - try again.';
        versions = [];
      });
  }

  $effect(() => {
    if (!open || bundleId === loadedFor) return;
    load(bundleId);
  });

  function retry(): void {
    load(bundleId);
  }

  function label(v: AppVersionEntry): string {
    return v.displayVersion ? `v${v.displayVersion}` : `id ${v.externalVersionId}`;
  }
</script>

<Dialog {open} {onOpenChange} class="max-w-lg">
  <div class="mb-3 text-sm font-medium">{trackName} - version history</div>

  {#if versions === null}
    <div class="text-sm text-muted">Loading version list from the App Store…</div>
  {:else if error}
    <div class="text-err mb-2.5 text-[13px]">{error}</div>
    <Button size="sm" variant="secondary" onclick={retry}>Try again</Button>
  {:else if versions.length === 0}
    <div class="text-sm text-muted">No version history found.</div>
  {:else}
    {#if versions.some((v) => !v.displayVersion)}
      <div class="text-muted mb-3 text-xs">Unlabeled versions are listed by App Store ID.</div>
    {/if}
    <div class="max-h-[50vh] overflow-y-auto">
      {#each versions as v (v.externalVersionId)}
        <div class="border-border flex items-center justify-between gap-3 border-t py-2 first:border-t-0">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 text-[13px]">
              {label(v)}
              {#if v.isLatest}
                <Badge variant="default">latest</Badge>
              {/if}
            </div>
            {#if v.releaseDate}
              <div class="text-muted text-xs">{fmtTime(new Date(v.releaseDate).getTime())}</div>
            {/if}
          </div>
          <Button size="sm" onclick={() => onDecrypt(bundleId, v.externalVersionId, label(v))}>Decrypt</Button>
        </div>
      {/each}
    </div>
  {/if}
</Dialog>
