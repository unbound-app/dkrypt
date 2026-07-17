<script lang="ts">
  import { Select as SelectPrimitive } from 'bits-ui';
  import { Check, ChevronDown } from 'lucide-svelte';
  import { cn } from '../../utils';

  interface Item {
    value: string;
    label: string;
  }

  interface Props {
    items: Item[];
    value: string;
    onValueChange?: (value: string) => void;
    class?: string;
    id?: string;
    disabled?: boolean;
  }

  let { items, value = $bindable(), onValueChange, class: className, id, disabled = false }: Props = $props();

  const selectedLabel = $derived(items.find((i) => i.value === value)?.label ?? '');
</script>

<SelectPrimitive.Root type="single" bind:value {onValueChange} {disabled}>
  <SelectPrimitive.Trigger
    {id}
    class={cn(
      'flex h-9 items-center justify-between gap-2 rounded-md border border-border bg-panel-muted px-3 text-sm text-text focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
      className,
    )}
  >
    <span class="truncate">{selectedLabel}</span>
    <ChevronDown class="text-muted h-4 w-4 shrink-0" />
  </SelectPrimitive.Trigger>
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content class="border-border bg-panel z-50 min-w-40 overflow-hidden rounded-md border shadow-lg" sideOffset={4}>
      <SelectPrimitive.Viewport class="p-1">
        {#each items as item (item.value)}
          <SelectPrimitive.Item
            value={item.value}
            label={item.label}
            class="data-highlighted:bg-panel-muted flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 text-sm text-text"
          >
            {#snippet children({ selected })}
              {item.label}
              {#if selected}<Check class="text-accent h-4 w-4" />{/if}
            {/snippet}
          </SelectPrimitive.Item>
        {/each}
      </SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
</SelectPrimitive.Root>
