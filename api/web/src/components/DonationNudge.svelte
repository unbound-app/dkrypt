<script lang="ts">
  import { Coffee, X } from 'lucide-svelte';
  import { KOFI_URL } from '#lib/constants';
  import { myDecryptsState } from '#lib/decrypts.svelte';
  import { liveState } from '#lib/live.svelte';
  import { sessionState } from '#lib/session.svelte';

  let dismissed = $state(localStorage.getItem('donationNudgeDismissed') === 'true');

  const isRoot = $derived(sessionState.sub === 'root');
  const hasSuccessfulDecrypt = $derived(myDecryptsState.items.some((d) => d.status === 'done'));

  const isPaidPlan = $derived(liveState.overview?.isPaidPlan ?? false);
  const show = $derived(!dismissed && !isRoot && !isPaidPlan && hasSuccessfulDecrypt);

  function dismiss(): void {
    dismissed = true;
    localStorage.setItem('donationNudgeDismissed', 'true');
  }
</script>

{#if show}
  <div class="border-accent/30 bg-accent/10 mb-4 flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]">
    <Coffee class="text-accent h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      dkrypt is free and ad-free - consider
      <a href={KOFI_URL} target="_blank" rel="noopener noreferrer" class="text-accent underline underline-offset-2 hover:no-underline">
        supporting the maintainer
      </a>.
    </div>
    <button class="text-muted hover:text-text cursor-pointer" onclick={dismiss} aria-label="Dismiss" title="Dismiss">
      <X class="h-3.5 w-3.5" />
    </button>
  </div>
{/if}
