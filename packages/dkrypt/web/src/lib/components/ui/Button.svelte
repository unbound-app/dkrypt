<script lang="ts">
  import { LoaderCircle } from 'lucide-svelte';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import { cn } from '#lib/utils';
  import { buttonSizeClasses, buttonVariantClasses, buttonBase, type ButtonSize, type ButtonVariant } from '#lib/components/ui/variants';

  interface Props extends HTMLButtonAttributes {
    variant?: ButtonVariant;
    size?: ButtonSize;
    loading?: boolean;
    children?: Snippet;
  }

  let { variant = 'default', size = 'default', loading = false, disabled, class: className, children, ...rest }: Props = $props();
</script>

<button class={cn(buttonBase, buttonVariantClasses[variant], buttonSizeClasses[size], className)} disabled={disabled || loading} {...rest}>
  {#if loading}
    <LoaderCircle class="size-3.5 animate-spin" />
  {/if}
  {@render children?.()}
</button>
