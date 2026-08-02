<script lang="ts">
  import { Copy, Download, FileSearch, GitBranch } from 'lucide-svelte';
  import { fetchJobTimeline, jobDiagnosticUrl, type JobTimeline } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtSize, fmtTime } from '#lib/format';
  import { statusToBadgeVariant } from '#lib/components/ui/variants';
  import { showToast } from '#lib/ui.svelte';

  let { open = $bindable(), jobId, title }: { open: boolean; jobId: string; title: string } = $props();
  let timeline = $state<JobTimeline | null>(null);
  let loading = $state(false);

  async function load(): Promise<void> {
    if (!jobId) return;
    loading = true;
    try {
      timeline = await fetchJobTimeline(jobId);
    } catch {
      timeline = null;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (open) void load();
  });

  async function copyDeepLink(): Promise<void> {
    const url = new URL(location.href);
    url.searchParams.set('job', jobId);
    await navigator.clipboard.writeText(url.toString());
    showToast('Job link copied', 'success');
  }

  function pretty(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
</script>

<Dialog bind:open class="max-w-xl">
  <div class="mb-4 flex items-start gap-3">
    <div class="min-w-0 flex-1">
      <div class="text-sm font-medium">{title}</div>
      <div class="mt-1 flex items-center gap-1.5 text-xs text-muted">
        <GitBranch class="h-3.5 w-3.5" />
        Correlation {jobId}
      </div>
    </div>
    <div class="flex shrink-0 gap-1.5">
      <Button size="sm" variant="secondary" onclick={() => void copyDeepLink()}><Copy class="h-3.5 w-3.5" />Link</Button>
      <a href={jobDiagnosticUrl(jobId)} download><Button size="sm" variant="secondary"><Download class="h-3.5 w-3.5" />Diagnostic</Button></a>
    </div>
  </div>

  {#if loading}
    <div class="text-sm text-muted">Loading job timeline…</div>
  {:else if timeline}
    <div class="border-border mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border p-3">
      <Badge variant={statusToBadgeVariant(timeline.status)}>{timeline.status}</Badge>
      {#if timeline.versionLabel}<span class="text-xs text-muted">{timeline.versionLabel}</span>{/if}
      {#if timeline.deviceId}<span class="text-xs text-muted">Device: {timeline.deviceId}</span>{/if}
      {#if timeline.sizeBytes}<span class="text-xs text-muted">{fmtSize(timeline.sizeBytes)}</span>{/if}
    </div>
    {#if timeline.guidance}
      <div class="border-warn/40 bg-warn/10 mb-4 rounded-lg border p-3 text-sm">
        <div class="font-medium">{timeline.guidance.title}</div>
        <div class="mt-1 text-muted">{timeline.guidance.action}</div>
      </div>
    {/if}
    {#if timeline.ipaMetadata}
      <section class="border-border mb-4 rounded-lg border p-3">
        <div class="mb-2 flex items-center gap-2 text-sm font-medium"><FileSearch class="text-accent h-4 w-4" />IPA inspection</div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div><div class="text-muted">App version</div><div>{timeline.ipaMetadata.shortVersion ?? '-'}</div></div>
          <div><div class="text-muted">Build</div><div>{timeline.ipaMetadata.bundleVersion ?? '-'}</div></div>
          <div><div class="text-muted">Minimum iOS</div><div>{timeline.ipaMetadata.minOsVersion ?? '-'}</div></div>
          <div><div class="text-muted">Executable</div><div class="truncate" title={timeline.ipaMetadata.executable}>{timeline.ipaMetadata.executable ?? '-'}</div></div>
          <div><div class="text-muted">Architectures</div><div>{timeline.ipaMetadata.architectures?.join(', ') || '-'}</div></div>
          <div><div class="text-muted">Files</div><div>{timeline.ipaMetadata.fileCount ?? '-'}</div></div>
          <div><div class="text-muted">Archive size</div><div>{timeline.ipaMetadata.compressedSizeBytes ? fmtSize(timeline.ipaMetadata.compressedSizeBytes) : '-'}</div></div>
          <div><div class="text-muted">Unpacked size</div><div>{timeline.ipaMetadata.uncompressedSizeBytes ? fmtSize(timeline.ipaMetadata.uncompressedSizeBytes) : '-'}</div></div>
          <div><div class="text-muted">Signature files</div><div>{timeline.ipaMetadata.codeSignaturePresent ? 'Detected' : 'Not detected'}</div></div>
        </div>
        {#if timeline.ipaMetadata.entitlementKeys?.length}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Entitlements ({timeline.ipaMetadata.entitlementKeys.length})</summary>
            <div class="mt-2 flex flex-wrap gap-1.5">{#each timeline.ipaMetadata.entitlementKeys as key (key)}<code class="bg-panel-muted rounded px-1.5 py-0.5 text-[11px]">{key}</code>{/each}</div>
          </details>
        {/if}
        {#if timeline.ipaMetadata.embeddedFrameworks?.length}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Embedded frameworks ({timeline.ipaMetadata.embeddedFrameworks.length})</summary>
            <div class="mt-2 flex flex-wrap gap-1.5">{#each timeline.ipaMetadata.embeddedFrameworks as framework (framework)}<code class="bg-panel-muted rounded px-1.5 py-0.5 text-[11px]">{framework}</code>{/each}</div>
          </details>
        {/if}
        {#if timeline.ipaInfoPlist}
          <details class="border-border mt-3 border-t pt-2">
            <summary class="cursor-pointer text-xs text-muted">Info.plist values</summary>
            <pre class="bg-panel-muted mt-2 max-h-48 overflow-auto rounded-lg p-2 text-[10px] leading-4">{pretty(timeline.ipaInfoPlist)}</pre>
          </details>
        {/if}
      </section>
    {/if}
    <ol class="max-h-80 space-y-3 overflow-y-auto pr-1">
      {#each timeline.events as event, index (`${event.at}-${event.label}`)}
        <li class="flex gap-3">
          <div class="flex flex-col items-center">
            <span class="bg-accent mt-1 h-2.5 w-2.5 rounded-full"></span>
            {#if index < timeline.events.length - 1}<span class="bg-border mt-1 h-full w-px"></span>{/if}
          </div>
          <div class="min-w-0 pb-2">
            <div class="text-sm text-text">{event.label}</div>
            <div class="mt-0.5 text-xs text-muted">{fmtTime(event.at)}</div>
          </div>
        </li>
      {/each}
    </ol>
  {:else}
    <div class="text-sm text-muted">Timeline is unavailable for this job.</div>
  {/if}
</Dialog>
