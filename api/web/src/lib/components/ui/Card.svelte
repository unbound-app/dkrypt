<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

  interface Props extends HTMLAttributes<HTMLDivElement> {
    title?: string;
    children?: Snippet;
    headerExtra?: Snippet;
  }

  let { title, class: className, children, headerExtra, ...rest }: Props = $props();
</script>

<div class={cn('min-w-0 rounded-xl border border-border bg-panel p-3.5 sm:p-4.5', className)} {...rest}>
  {#if title || headerExtra}
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      {#if title}
        <h2 class="text-[13px] font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {/if}
      {#if headerExtra}
        {@render headerExtra()}
      {/if}
    </div>
  {/if}
  {@render children?.()}
</div>
