<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';

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
    'glass-input h-9 w-full rounded-xl px-3 text-sm text-text placeholder:text-muted focus:outline-none disabled:opacity-50',
    className,
  )}
  {...rest}
/>
