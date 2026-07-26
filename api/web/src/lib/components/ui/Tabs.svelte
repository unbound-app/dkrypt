<script lang="ts">
  import { Tabs as TabsPrimitive } from 'bits-ui';
  import { scrollFade } from '#lib/scrollFade';
  import { cn } from '#lib/utils';

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
  <div class="scroll-fade-x overflow-x-auto" use:scrollFade style="--scroll-fade-bg: var(--color-panel);">
    <TabsPrimitive.List class="border-border bg-panel-muted/60 inline-flex min-w-full gap-1 rounded-lg border p-1 sm:min-w-0">
      {#each items as item (item.id)}
        <TabsPrimitive.Trigger
          value={item.id}
          class="text-muted data-[state=active]:bg-panel data-[state=active]:text-text relative cursor-pointer rounded-md px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors"
        >
          {item.label}
        </TabsPrimitive.Trigger>
      {/each}
    </TabsPrimitive.List>
  </div>
</TabsPrimitive.Root>
