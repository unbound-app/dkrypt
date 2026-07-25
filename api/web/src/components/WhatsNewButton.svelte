<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Sparkles } from 'lucide-svelte';
  import { CHANGELOG, type ChangelogEntry } from '#lib/changelog';
  import { buttonVariants } from '#lib/components/ui/variants';
  import { setActiveTab, setSettingsSubtab, type TabId } from '#lib/ui.svelte';
  import { cn } from '#lib/utils';

  const LAST_VIEWED_KEY = 'changelogLastViewedDate';
  const latestDate = CHANGELOG[0]?.date ?? '';

  let open = $state(false);
  let lastViewedDate = $state(localStorage.getItem(LAST_VIEWED_KEY) ?? '');

  const hasUnseen = $derived(latestDate > lastViewedDate);

  function onOpenChange(v: boolean): void {
    open = v;
    if (v && latestDate) {
      lastViewedDate = latestDate;
      localStorage.setItem(LAST_VIEWED_KEY, latestDate);
    }
  }

  function followLink(entry: ChangelogEntry): void {
    if (!entry.link) return;
    open = false;
    setActiveTab(entry.link.tab as TabId);
    if (entry.link.subtab) setSettingsSubtab(entry.link.subtab);
  }
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger class={cn(buttonVariants('secondary', 'icon'), 'relative')} aria-label="What's new" title="What's new">
    <Sparkles class="h-4 w-4" />
    {#if hasUnseen}
      <span class="bg-err absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full"></span>
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="border-border bg-panel z-50 w-80 rounded-xl border p-3 shadow-2xl" sideOffset={8} align="end">
      <div class="mb-2 text-sm font-medium">What's new</div>
      <div class="flex max-h-96 flex-col gap-3 overflow-y-auto">
        {#each CHANGELOG as entry (entry.date + entry.title)}
          <div class="text-xs">
            <div class="mb-0.5 flex items-center justify-between gap-2">
              {#if entry.link}
                <button
                  class="text-text cursor-pointer font-medium hover:text-accent hover:underline"
                  onclick={() => followLink(entry)}
                  title="Go to this feature"
                >
                  {entry.title}
                </button>
              {:else}
                <span class="text-text font-medium">{entry.title}</span>
              {/if}
              <span class="text-muted shrink-0">{entry.date}</span>
            </div>
            <div class="text-muted leading-relaxed">{entry.description}</div>
          </div>
        {/each}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
