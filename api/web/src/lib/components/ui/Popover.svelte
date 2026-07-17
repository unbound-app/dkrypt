<script lang="ts">
  import { Popover as PopoverPrimitive } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { cn } from '../../utils';

  interface Props {
    trigger?: Snippet;
    children?: Snippet;
    triggerClass?: string;
    class?: string;
  }

  let { trigger, children, triggerClass, class: className }: Props = $props();
</script>

<PopoverPrimitive.Root>
  <PopoverPrimitive.Trigger class={cn('cursor-pointer border-none bg-transparent p-0', triggerClass)}>
    {@render trigger?.()}
  </PopoverPrimitive.Trigger>
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      sideOffset={6}
      class={cn('border-border bg-panel z-50 rounded-lg border p-3 text-xs shadow-2xl', className)}
    >
      {@render children?.()}
    </PopoverPrimitive.Content>
  </PopoverPrimitive.Portal>
</PopoverPrimitive.Root>
