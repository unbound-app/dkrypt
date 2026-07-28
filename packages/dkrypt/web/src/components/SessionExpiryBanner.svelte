<script lang="ts">
  import { fmtCountdown } from '#lib/format';
  import { refreshSessionTtl, sessionState } from '#lib/session.svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { showToast } from '#lib/ui.svelte';

  const WARN_WINDOW_MS = 5 * 60_000;

  let now = $state(Date.now());
  let refreshing = $state(false);
  let dismissed = $state(false);

  const remaining = $derived(sessionState.expiresAt ? sessionState.expiresAt - now : Infinity);
  const showWarning = $derived(sessionState.loggedIn && remaining <= WARN_WINDOW_MS && remaining > 0);

  $effect(() => {
    if (!showWarning) dismissed = false;
  });

  $effect(() => {

    const interval = showWarning ? 1000 : 30_000;
    const timer = setInterval(() => {
      now = Date.now();
    }, interval);
    return () => clearInterval(timer);
  });

  async function staySignedIn(): Promise<void> {
    refreshing = true;
    try {
      const ok = await refreshSessionTtl();
      showToast(ok ? "You're signed in for another 12 hours" : 'Failed to extend session', ok ? 'success' : 'error');
    } finally {
      refreshing = false;
    }
  }
</script>

{#if showWarning && !dismissed}
  <div
    class="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn"
    role="status"
    aria-live="polite"
  >
    <span>Your session expires in {fmtCountdown(remaining)} - save your work or stay signed in.</span>
    <div class="flex shrink-0 items-center gap-1.5">
      <Button size="sm" variant="secondary" loading={refreshing} onclick={staySignedIn}>Stay signed in</Button>
      <Button size="sm" variant="secondary" onclick={() => (dismissed = true)} aria-label="Dismiss">Dismiss</Button>
    </div>
  </div>
{/if}
