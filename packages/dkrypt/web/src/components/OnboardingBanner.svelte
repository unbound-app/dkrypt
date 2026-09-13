<script lang="ts">
  import { Rocket, X } from 'lucide-svelte';
  import { fetchInsights } from '#lib/api';
  import { liveState } from '#lib/live.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasPermission } from '#lib/session.svelte';
  import { setActiveTab, setSettingsSubtab } from '#lib/ui.svelte';
  import Alert from '#lib/components/ui/Alert.svelte';
  import Button from '#lib/components/ui/Button.svelte';

  const DISMISSED_KEY = 'onboardingDismissed';
  let dismissed = $state(localStorage.getItem(DISMISSED_KEY) === 'true');
  let totalRuns = $state<number | null>(null);

  $effect(() => {
    if (!dismissed && sessionHasPermission(PermissionFlag.manageDevices)) {
      void fetchInsights(7, 1).then((r) => (totalRuns = r.totalRuns));
    }
  });

  const watchCount = $derived(liveState.overview?.watches.length ?? 0);
  const show = $derived(!dismissed && totalRuns === 0 && watchCount === 0);

  function dismiss(): void {
    dismissed = true;
    localStorage.setItem(DISMISSED_KEY, 'true');
  }

  function goToDevices(): void {
    setActiveTab('settings');
    setSettingsSubtab('devices');
  }

  function goToWatches(): void {
    setActiveTab('settings');
    setSettingsSubtab('scheduler');
  }
</script>

{#if show}
  <Alert class="mb-4 border-primary/30 bg-primary/10 px-4 py-3.5 text-[13px]">
    <div class="flex items-start gap-2.5">
      <Rocket class="text-accent mt-0.5 h-4 w-4 shrink-0" />
      <div class="min-w-0 flex-1">
        <div class="font-medium">Welcome to dkrypt - a few things to get set up:</div>
        <ol class="mt-1.5 list-decimal space-y-1 pl-4 text-muted">
          <li>
            Open <Button variant="link" size="sm" class="h-auto p-0 text-primary" onclick={goToDevices}>Settings → Devices</Button> and use
            <strong>Find a device</strong> to connect your jailbroken iPhone or iPad and check its setup.
          </li>
          <li>Once a device is reachable, try a decrypt from the search box on this page.</li>
          <li>
            Optionally, <Button variant="link" size="sm" class="h-auto p-0 text-primary" onclick={goToWatches}>add a watch</Button> to auto-decrypt
            new releases, and check <Button variant="link" size="sm" class="h-auto p-0 text-primary" onclick={goToDevices}>Settings → Devices</Button> if
            you're pooling more than one.
          </li>
        </ol>
      </div>
      <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-muted hover:text-foreground" onclick={dismiss} aria-label="Dismiss" title="Dismiss">
        <X class="h-3.5 w-3.5" />
      </Button>
    </div>
  </Alert>
{/if}
