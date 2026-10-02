<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { cn } from '#lib/utils';

  interface Props {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    class?: string;
    title?: string;
    children?: Snippet;
  }

  let { open = $bindable(), onOpenChange, class: className, title, children }: Props = $props();
</script>

<DialogPrimitive.Root bind:open {onOpenChange}>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay class="bg-background/80 fixed inset-0 z-50 backdrop-blur-sm" />
    <DialogPrimitive.Content
      class={cn(
        'bg-card text-card-foreground fixed top-1/2 left-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border p-6 shadow-lg',
        className,
      )}
    >
      {#if title}<DialogPrimitive.Title class="sr-only">{title}</DialogPrimitive.Title>{/if}
      {@render children?.()}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
