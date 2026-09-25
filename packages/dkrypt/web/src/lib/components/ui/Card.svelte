<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    title?: string;
    contentClass?: string;
    children?: Snippet;
    headerExtra?: Snippet;
  }

  let { title, contentClass, class: className, children, headerExtra, ...rest }: Props = $props();
</script>

<div data-slot="card" class={cn('bg-card text-card-foreground min-w-0 rounded-xl border border-border/80 shadow-sm', className)} {...rest}>
  {#if title || headerExtra}
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 px-5 py-4">
      {#if title}
        <h2 class="text-sm font-semibold tracking-tight text-foreground">{title}</h2>
      {/if}
      {#if headerExtra}
        {@render headerExtra()}
      {/if}
    </div>
  {/if}
  <div class={cn('p-5', title || headerExtra ? '' : 'pt-5', contentClass)}>
    {@render children?.()}
  </div>
</div>
