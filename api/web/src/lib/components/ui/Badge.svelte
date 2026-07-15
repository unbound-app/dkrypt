<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { cn } from '../../utils';
  import { badgeVariantClasses, type BadgeVariant } from './variants';

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant;
    children?: Snippet;
  }

  let { variant = 'default', class: className, children, ...rest }: Props = $props();
</script>

<span
  class={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap', badgeVariantClasses[variant], className)}
  {...rest}
>
  {@render children?.()}
</span>
