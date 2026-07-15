<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '../../utils';

  interface Props extends HTMLInputAttributes {
    class?: string;
    ref?: HTMLInputElement;
  }

  let { class: className, value = $bindable(), ref = $bindable(), ...rest }: Props = $props();
</script>

<input
  bind:this={ref}
  bind:value
  class={cn(
    'h-9 w-full rounded-md border border-border bg-panel-muted px-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50',
    className,
  )}
  {...rest}
/>
