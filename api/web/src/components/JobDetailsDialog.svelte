<script lang="ts">
  import { Copy, Download, GitBranch, Link } from 'lucide-svelte';
  import { fetchJobTimeline, jobDiagnosticUrl, regenerateWorkflowHandoff, type JobTimeline } from '#lib/api';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtTime } from '#lib/format';
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

  async function recoverHandoff(): Promise<void> {
    const { ok, data } = await regenerateWorkflowHandoff(jobId);
    if (!ok) return;
    await navigator.clipboard.writeText(data.url);
    showToast('Fresh workflow handoff URL copied', 'success');
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
      {#if timeline?.status === 'done'}<Button size="sm" variant="secondary" onclick={() => void recoverHandoff()}><Link class="h-3.5 w-3.5" />Handoff</Button>{/if}
      <a href={jobDiagnosticUrl(jobId)} download><Button size="sm" variant="secondary"><Download class="h-3.5 w-3.5" />Diagnostic</Button></a>
    </div>
  </div>

  <div class="mb-4 grid grid-cols-4 gap-1 text-center text-[10px] text-muted">
    {#each ['Queued', 'Install', 'Decrypt', 'Complete'] as step, index (step)}
      <div class="flex items-center gap-1">
        <span class={timeline && timeline.events.length > index ? 'bg-accent h-2 w-2 rounded-full' : 'bg-border h-2 w-2 rounded-full'}></span>
        <span>{step}</span>
      </div>
    {/each}
  </div>

  {#if loading}
    <div class="text-sm text-muted">Loading job timeline…</div>
  {:else if timeline}
    {#if timeline.guidance}
      <div class="border-warn/40 bg-warn/10 mb-4 rounded-lg border p-3 text-sm">
        <div class="font-medium">{timeline.guidance.title}</div>
        <div class="mt-1 text-muted">{timeline.guidance.action}</div>
      </div>
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
