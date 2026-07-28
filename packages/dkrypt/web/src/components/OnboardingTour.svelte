<script lang="ts">
  import { HeartPulse, KeyRound, Search, SquareTerminal, Sparkles as SparklesIcon } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { sessionState } from '#lib/session.svelte';
  import { openHelp, openPalette, setActiveTab } from '#lib/ui.svelte';

  const SEEN_KEY = 'onboardingTourSeen';

  interface Step {
    icon: typeof Search;
    title: string;
    body: string;
    actionLabel?: string;
    action?: () => void;
  }

  const steps: Step[] = [
    {
      icon: HeartPulse,
      title: 'Check device readiness first',
      body: 'Open Settings → Devices and run Preflight before your first decrypt. It checks SSH, App Store connectivity, autoinstall compatibility, and available capacity.',
      actionLabel: 'Open Devices',
      action: () => setActiveTab('settings'),
    },
    {
      icon: Search,
      title: 'Decrypt any app',
      body: "Search for an app on the Home tab and hit decrypt. If it's still running when the request times out, you'll get a job you can watch finish live.",
    },
    {
      icon: KeyRound,
      title: 'API keys for scripts & CI',
      body: 'Everything you can do from the dashboard is also available over HTTP with an API key - see the Docs tab for curl examples.',
      actionLabel: 'Go to API Keys',
      action: () => setActiveTab('keys'),
    },
    {
      icon: SquareTerminal,
      title: 'Command palette',
      body: 'Press Cmd/Ctrl+K from anywhere to jump to a tab, run an action, or find a recent decrypt instantly.',
      actionLabel: 'Try it now',
      action: () => openPalette(),
    },
    {
      icon: SparklesIcon,
      title: 'Keyboard shortcuts',
      body: "Press ? anytime to see the full list - g then a letter jumps to a tab, / focuses search, b opens batch decrypt.",
      actionLabel: 'Show shortcuts',
      action: () => openHelp(),
    },
  ];

  let open = $state(false);
  let index = $state(0);

  $effect(() => {
    if (sessionState.loggedIn && localStorage.getItem(SEEN_KEY) !== 'true') open = true;
  });

  const step = $derived(steps[index]);
  const StepIcon = $derived(step.icon);
  const isLast = $derived(index === steps.length - 1);

  function finish(): void {
    localStorage.setItem(SEEN_KEY, 'true');
    open = false;
  }

  function next(): void {
    if (isLast) {
      finish();
      return;
    }
    index += 1;
  }
</script>

<Dialog {open} onOpenChange={(v) => !v && finish()} class="max-w-sm">
  <div class="mb-3 flex items-center gap-2.5">
    <div class="bg-accent/15 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
      <StepIcon class="text-accent h-4.5 w-4.5" />
    </div>
    <div class="text-sm font-semibold">{step.title}</div>
  </div>
  <p class="text-sm leading-relaxed text-muted">{step.body}</p>
  <div class="mt-4 flex items-center justify-between gap-2">
    <div class="flex gap-1">
      {#each steps as _, i (i)}
        <span class={i === index ? 'bg-accent h-1.5 w-4 rounded-full' : 'bg-border h-1.5 w-1.5 rounded-full'}></span>
      {/each}
    </div>
    <div class="flex gap-2">
      <button type="button" class="text-muted hover:text-text cursor-pointer text-xs" onclick={finish}>Skip</button>
      {#if step.actionLabel}
        <Button
          size="sm"
          variant="secondary"
          onclick={() => {
            step.action?.();
            next();
          }}
        >
          {step.actionLabel}
        </Button>
      {/if}
      <Button size="sm" onclick={next}>{isLast ? 'Done' : 'Next'}</Button>
    </div>
  </div>
</Dialog>
