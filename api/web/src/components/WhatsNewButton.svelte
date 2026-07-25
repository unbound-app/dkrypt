<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Sparkles } from 'lucide-svelte';
  import { CHANGELOG } from '#lib/changelog';
  import { buttonVariants } from '#lib/components/ui/variants';
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
              <span class="text-text font-medium">{entry.title}</span>
              <span class="text-muted shrink-0">{entry.date}</span>
            </div>
            <div class="text-muted leading-relaxed">{entry.description}</div>
          </div>
        {/each}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
