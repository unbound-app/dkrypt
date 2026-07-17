<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Bell } from 'lucide-svelte';
  import { buttonVariants } from '../lib/components/ui/variants';
  import { clearToastHistory, toastHistoryState } from '../lib/ui.svelte';
  import { cn } from '../lib/utils';
  import RelativeTime from './RelativeTime.svelte';

  let open = $state(false);
  let lastViewedAt = $state(0);

  const unseenCount = $derived(toastHistoryState.items.filter((t) => t.ts > lastViewedAt).length);

  function onOpenChange(v: boolean): void {
    open = v;
    if (v) lastViewedAt = Date.now();
  }
</script>

<Popover.Root bind:open {onOpenChange}>
  <Popover.Trigger class={cn(buttonVariants('secondary', 'icon'), 'relative')} aria-label="Notifications" title="Notifications">
    <Bell class="h-4 w-4" />
    {#if unseenCount > 0}
      <span class="bg-err text-accent-contrast absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
        {unseenCount > 9 ? '9+' : unseenCount}
      </span>
    {/if}
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="border-border bg-panel z-50 w-72 rounded-xl border p-3 shadow-2xl" sideOffset={8} align="end">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-medium">Notifications</span>
        {#if toastHistoryState.items.length > 0}
          <button class="text-muted hover:text-text cursor-pointer text-xs" onclick={clearToastHistory}>Clear</button>
        {/if}
      </div>
      {#if toastHistoryState.items.length === 0}
        <div class="text-sm text-muted">Nothing yet.</div>
      {:else}
        <div class="flex max-h-72 flex-col gap-2 overflow-y-auto">
          {#each toastHistoryState.items as t (t.id)}
            <div class="flex items-start gap-2 text-xs">
              <span class={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', t.type === 'error' ? 'bg-err' : 'bg-ok')}></span>
              <div class="min-w-0 flex-1">
                <div class="text-text">{t.message}</div>
                <div class="text-muted mt-0.5"><RelativeTime ms={t.ts} /></div>
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
