<script lang="ts">
  import { Tabs as TabsPrimitive } from 'bits-ui';
  import { scrollFade } from '../../scrollFade';
  import { cn } from '../../utils';

  interface TabItem {
    id: string;
    label: string;
  }

  interface Props {
    items: TabItem[];
    value: string;
    onValueChange: (value: string) => void;
    class?: string;
  }

  let { items, value, onValueChange, class: className }: Props = $props();
</script>

<TabsPrimitive.Root {value} {onValueChange} class={cn('w-full', className)}>
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade style="--scroll-fade-bg: var(--color-bg);">
    <TabsPrimitive.List class="border-border flex gap-1 border-b">
      {#each items as item (item.id)}
        <TabsPrimitive.Trigger
          value={item.id}
          class="text-muted data-[state=active]:text-text after:bg-accent relative cursor-pointer px-3.5 py-2.5 text-sm whitespace-nowrap after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:scale-x-0 after:transition-transform data-[state=active]:after:scale-x-100"
        >
          {item.label}
        </TabsPrimitive.Trigger>
      {/each}
    </TabsPrimitive.List>
  </div>
</TabsPrimitive.Root>
