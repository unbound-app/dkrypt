<script lang="ts">
  import { fmtCountdown } from '../lib/format';
  import { sessionState } from '../lib/session.svelte';

  const WARN_WINDOW_MS = 5 * 60_000;

  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const remaining = $derived(sessionState.expiresAt ? sessionState.expiresAt - now : Infinity);
  const showWarning = $derived(sessionState.loggedIn && remaining <= WARN_WINDOW_MS && remaining > 0);
</script>

{#if showWarning}
  <div class="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn">
    Your session expires in {fmtCountdown(remaining)} - save your work and sign in again soon.
  </div>
{/if}
