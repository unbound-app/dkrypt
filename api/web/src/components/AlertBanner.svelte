<script lang="ts">
  import { TriangleAlert } from 'lucide-svelte';
  import { clearAuthAlert, startAppleAuth } from '../lib/api';
  import Button from '../lib/components/ui/Button.svelte';
  import { fmtRelative, fmtTime } from '../lib/format';
  import { liveState } from '../lib/live.svelte';
  import { PermissionFlag } from '../lib/permissions';
  import { sessionHasPermission } from '../lib/session.svelte';
  import { setActiveTab, setSettingsSubtab } from '../lib/ui.svelte';

  const alert = $derived(liveState.overview?.appleAuthAlert);
  let dismissing = $state(false);
  let startingReauth = $state(false);

  async function dismiss(): Promise<void> {
    dismissing = true;
    try {
      await clearAuthAlert();
    } finally {
      dismissing = false;
    }
  }

  async function startReauth(): Promise<void> {
    startingReauth = true;
    try {
      await startAppleAuth();
    } finally {
      startingReauth = false;
      setActiveTab('settings');
      setSettingsSubtab('apple');
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
      <div class="mt-2 flex gap-2">
        {#if sessionHasPermission(PermissionFlag.manageAppleAuth)}
          <Button size="sm" loading={startingReauth} onclick={startReauth}>Start re-auth</Button>
        {/if}
        {#if sessionHasPermission(PermissionFlag.manageAutomation)}
          <Button variant="secondary" size="sm" loading={dismissing} onclick={dismiss}>Dismiss</Button>
        {/if}
      </div>
    </div>
  </div>
{/if}
