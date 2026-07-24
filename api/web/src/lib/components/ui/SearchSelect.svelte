<script lang="ts">
  import { Combobox } from 'bits-ui';
  import { Check, ChevronDown } from 'lucide-svelte';
  import { cn } from '#lib/utils';

  interface Item {
    value: string;
    label: string;
  }

  interface Props {
    items: Item[];
    value: string;
    onValueChange?: (value: string) => void;
    placeholder?: string;
    class?: string;
    id?: string;
    disabled?: boolean;
    maxVisible?: number;
  }

  let { items, value = $bindable(), onValueChange, placeholder = 'Search…', class: className, id, disabled = false, maxVisible = 50 }: Props = $props();

  let open = $state(false);
  let query = $state('');

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.label.toLowerCase().includes(q)) : items;
  });
  const visible = $derived(filtered.slice(0, maxVisible));
  const hiddenCount = $derived(filtered.length - visible.length);

  $effect(() => {
    if (!open) query = items.find((i) => i.value === value)?.label ?? '';
  });
</script>

<Combobox.Root type="single" bind:value bind:open {items} {onValueChange} {disabled} inputValue={query}>
  <div class="relative">
    <Combobox.Input
      {id}
      {placeholder}
      onfocus={() => (open = true)}
      oninput={(e: Event) => {
        query = (e.currentTarget as HTMLInputElement).value;
        open = true;
      }}
      class={cn(
        'flex h-9 w-full items-center rounded-md border border-border bg-panel-muted px-3 pr-8 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
    />
    <ChevronDown class="text-muted pointer-events-none absolute top-1/2 right-2.5 h-4 w-4 -translate-y-1/2" />
  </div>
  <Combobox.Portal>
    <Combobox.Content
      class="border-border bg-panel z-50 overflow-hidden rounded-md border shadow-lg"
      style="width: var(--bits-floating-anchor-width); min-width: max(var(--bits-floating-anchor-width), 12rem);"
      sideOffset={4}
    >
      <Combobox.Viewport class="max-h-64 overflow-y-auto p-1">
        {#each visible as item (item.value)}
          <Combobox.Item
            value={item.value}
            label={item.label}
            class="data-highlighted:bg-panel-muted flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm text-text"
          >
            {#snippet children({ selected })}
              <span class="truncate">{item.label}</span>
              {#if selected}<Check class="text-accent h-4 w-4 shrink-0" />{/if}
            {/snippet}
          </Combobox.Item>
        {/each}
        {#if visible.length === 0}
          <div class="px-2 py-2 text-xs text-muted">No matches.</div>
        {:else if hiddenCount > 0}
          <div class="px-2 py-1.5 text-[11px] text-muted">{hiddenCount} more - keep typing to narrow it down</div>
        {/if}
      </Combobox.Viewport>
    </Combobox.Content>
  </Combobox.Portal>
</Combobox.Root>
