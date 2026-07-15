<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '../../utils';
  import { buttonSizeClasses, buttonVariantClasses, buttonBase, type ButtonSize, type ButtonVariant } from './variants';

  interface Props extends HTMLButtonAttributes {
    variant?: ButtonVariant;
    size?: ButtonSize;
    children?: Snippet;
  }

  let { variant = 'default', size = 'default', class: className, children, ...rest }: Props = $props();
</script>

<button class={cn(buttonBase, buttonVariantClasses[variant], buttonSizeClasses[size], className)} {...rest}>
  {@render children?.()}
</button>
