<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { clearAuthAlert } from '../lib/api';
  import Button from '../lib/components/ui/Button.svelte';
  import { fmtRelative, fmtTime } from '../lib/format';
  import { liveState } from '../lib/live.svelte';
  import { sessionState } from '../lib/session.svelte';

  const alert = $derived(liveState.overview?.appleAuthAlert);
  let dismissing = $state(false);

  async function dismiss(): Promise<void> {
    dismissing = true;
    try {
      await clearAuthAlert();
    } finally {
      dismissing = false;
    }
  }
</script>

{#if alert?.suspected}
  <div class="mb-4 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn">
    <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
    <div class="min-w-0 flex-1">
      <div>
        App Store auth may need re-authentication (last error <span title={fmtTime(alert.lastErrorAt)}>{fmtRelative(alert.lastErrorAt)}</span>):
      </div>
      <code class="mt-1 block break-all text-[12px]">{alert.lastError ?? ''}</code>
      {#if sessionState.permissions?.manageSettings}
        <Button variant="secondary" size="sm" class="mt-2" loading={dismissing} onclick={dismiss}>Dismiss</Button>
      {/if}
    </div>
  </div>
{/if}
