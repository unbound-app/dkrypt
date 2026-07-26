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
    <TabsPrimitive.List class="glass-tabs inline-flex min-w-full gap-1 p-1 sm:min-w-0">
      {#each items as item (item.id)}
        <TabsPrimitive.Trigger
          value={item.id}
          class="text-muted data-[state=active]:text-text relative cursor-pointer rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors data-[state=active]:[background:color-mix(in_srgb,var(--color-panel)_72%,transparent)] data-[state=active]:shadow-sm"
        >
          {item.label}
        </TabsPrimitive.Trigger>
      {/each}
    </TabsPrimitive.List>
  </div>
</TabsPrimitive.Root>
