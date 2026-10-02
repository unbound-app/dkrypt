<script lang="ts">
  import type { Snippet } from 'svelte';
  import { X } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { interfaceLanguageState, systemLocalesState } from '#lib/ui.svelte';
  import { resolveInterfaceLanguage } from '#lib/locale';
  import { translateMessage } from '#lib/messages';

  interface Props {
    open: boolean;
    title: string;
    onOpenChange?: (open: boolean) => void;
    children?: Snippet;
  }

  let { open = $bindable(), title, onOpenChange, children }: Props = $props();
  const interfaceLanguage = $derived(resolveInterfaceLanguage(interfaceLanguageState.value, systemLocalesState.value));

  function close(): void {
    open = false;
    onOpenChange?.(false);
  }

  $effect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });
</script>

{#if open}
<dialog
  open
  aria-modal="false"
  aria-label={title}
  tabindex="-1"
  class="fixed inset-y-0 right-0 z-50 m-0 max-h-none max-w-none w-[min(48rem,92vw)] border-0 border-l border-border bg-card p-0 text-card-foreground shadow-2xl max-lg:inset-x-0 max-lg:inset-y-auto max-lg:bottom-0 max-lg:h-[85dvh] max-lg:w-full max-lg:rounded-t-2xl max-lg:border-l-0 max-lg:border-t"
>
  <div class="h-full overflow-y-auto p-5 sm:p-7">
    <div class="sticky -mx-5 -mt-5 z-10 flex items-center justify-between gap-3 bg-card/95 p-2 backdrop-blur sm:-mx-7 sm:-mt-7 sm:p-3">
      <h2 class="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <Button variant="ghost" size="icon" class="h-8 w-8" aria-label={translateMessage('dialog.closeInspector', interfaceLanguage)} onclick={close}><X class="h-4 w-4" /></Button>
    </div>
    {@render children?.()}
  </div>
</dialog>
{/if}
