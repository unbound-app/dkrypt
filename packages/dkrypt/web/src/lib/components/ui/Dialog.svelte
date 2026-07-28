<script lang="ts">
  import { Dialog as DialogPrimitive } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import { cn } from '#lib/utils';

  interface Props {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    class?: string;
    children?: Snippet;
  }

  let { open = $bindable(), onOpenChange, class: className, children }: Props = $props();
</script>

<DialogPrimitive.Root bind:open {onOpenChange}>
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-black/45 backdrop-blur-sm" />
    <DialogPrimitive.Content
      class={cn(
        'glass-card fixed top-1/2 left-1/2 z-50 w-[90%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-[1.5rem] p-5',
        className,
      )}
    >
      {@render children?.()}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
</DialogPrimitive.Root>
