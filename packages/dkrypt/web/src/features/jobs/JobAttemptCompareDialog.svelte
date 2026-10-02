<script lang="ts">
  import { fetchJobAttemptComparison, type JobAttemptComparison } from '#lib/api';
  import Badge from '#lib/components/ui/Badge.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { fmtDateTime, fmtDurationApprox } from '#lib/format.svelte';

  let { open = $bindable(), ids }: { open: boolean; ids: [string, string] } = $props();
  let result = $state<JobAttemptComparison | null>(null);
  let loading = $state(false);
  let error = $state('');

  $effect(() => {
    if (!open) return;
    result = null;
    error = '';
    loading = true;
    void fetchJobAttemptComparison(ids[0], ids[1]).then((comparison) => {
      result = comparison;
    }).catch((cause) => {
      error = cause instanceof Error ? cause.message : 'Could not compare these job attempts';
    }).finally(() => {
      loading = false;
    });
  });
</script>

<Dialog bind:open title="Compare job attempts" class="max-h-[85dvh] max-w-3xl overflow-y-auto">
  <div class="mb-4 flex items-start justify-between gap-3"><div><h2 class="text-base font-semibold">Compare attempts</h2><p class="text-muted mt-1 text-xs">Both records are checked against the same app build before details are shown.</p></div><Button size="sm" variant="secondary" onclick={() => (open = false)}>Close</Button></div>
  {#if loading}<div role="status" class="text-sm text-muted">Loading attempt comparison…</div>
  {:else if error}<div role="alert" class="text-sm text-err">{error}</div>
  {:else if result}
    <div class="mb-4 flex flex-wrap items-center gap-2"><Badge variant="secondary">{result.changedFields.length} fields differ</Badge><Badge variant="outline">Duration delta {fmtDurationApprox(Math.abs(result.durationDeltaMs))} {result.durationDeltaMs < 0 ? 'faster' : result.durationDeltaMs > 0 ? 'slower' : 'same'}</Badge></div>
    <div class="grid gap-3 sm:grid-cols-2">
      {#each [result.a, result.b] as attempt, index (attempt.id)}
        <section class="rounded-lg border border-border/70 p-3" aria-label="Attempt {index + 1}">
          <div class="flex items-center justify-between gap-2"><h3 class="text-sm font-semibold">Attempt {index + 1}{#if attempt.attempt} · #{attempt.attempt}{/if}</h3><Badge variant={attempt.status === 'done' ? 'secondary' : 'destructive'}>{attempt.status}</Badge></div>
          <div class="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
            <span class="text-muted">Finished</span><span>{fmtDateTime(attempt.finishedAt)}</span>
            <span class="text-muted">Duration</span><span>{attempt.durationMs === undefined ? 'Unavailable' : fmtDurationApprox(attempt.durationMs)}</span>
            <span class="text-muted">Device</span><span class="break-all" data-sensitive="true">{attempt.deviceId ?? 'Unavailable'}</span>
            <span class="text-muted">Transport</span><span>{attempt.transport ?? 'Unavailable'}</span>
            <span class="text-muted">Cache</span><span>{attempt.cacheHit ? 'Hit' : 'Miss or unavailable'}</span>
            <span class="text-muted">Deadline</span><span>{attempt.deadlineExceeded ? 'Exceeded' : 'Not exceeded'}</span>
          </div>
          {#if attempt.error}<p class="mt-3 break-words text-xs text-err">{attempt.error}</p>{/if}
          {#if attempt.warnings?.length}<ul class="mt-2 list-disc pl-4 text-xs text-muted">{#each attempt.warnings as warning (warning)}<li>{warning}</li>{/each}</ul>{/if}
        </section>
      {/each}
    </div>
    {#if result.changedFields.length > 0}<div class="mt-4 text-xs"><span class="font-semibold">Different fields: </span>{result.changedFields.join(', ')}</div>{/if}
  {/if}
</Dialog>
