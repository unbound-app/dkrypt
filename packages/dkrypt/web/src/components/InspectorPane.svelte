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
  const storageKey = $derived(`dkrypt-inspector-width:${title === 'Artifact details' ? 'artifact' : 'job'}`);
  let widthRatio = $state(0.6);

  function setWidthRatio(value: number): void {
    widthRatio = Math.min(0.75, Math.max(0.3, value));
    localStorage.setItem(storageKey, String(widthRatio));
  }

  function startResize(event: PointerEvent): void {
    if (window.innerWidth < 1024) return;
    const handle = event.currentTarget as HTMLElement;
    handle.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setWidthRatio((window.innerWidth - next.clientX) / window.innerWidth);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function resizeWithKeyboard(event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    setWidthRatio(widthRatio + (event.key === 'ArrowLeft' ? 0.02 : -0.02));
  }

  function close(): void {
    open = false;
    onOpenChange?.(false);
  }

  $effect(() => {
    if (!open) return;
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved >= 0.3 && saved <= 0.75) widthRatio = saved;
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
  style={`width: min(${Math.round(widthRatio * 100)}vw, calc(100vw - 20rem))`}
  class="fixed inset-y-0 right-0 left-auto z-50 m-0 h-dvh max-h-none max-w-none border-0 border-l border-border bg-card p-0 text-card-foreground shadow-2xl max-lg:inset-x-0 max-lg:inset-y-auto max-lg:bottom-0 max-lg:h-[85dvh] max-lg:!w-full max-lg:rounded-t-2xl max-lg:border-l-0 max-lg:border-t"
>
		<button type="button" aria-label={`Resize ${title} panel, ${Math.round(widthRatio * 100)} percent wide. Use left and right arrow keys.`} class="absolute inset-y-0 left-0 hidden w-2 -translate-x-1/2 cursor-col-resize touch-none focus-visible:bg-primary/30 lg:block" onpointerdown={startResize} onkeydown={resizeWithKeyboard}></button>
  <div class="h-full overflow-y-auto p-5 sm:p-7">
    <div class="sticky -mx-5 -mt-5 z-10 flex items-center justify-between gap-3 bg-card/95 p-2 backdrop-blur sm:-mx-7 sm:-mt-7 sm:p-3">
      <h2 class="min-w-0 truncate text-sm font-semibold">{title}</h2>
      <Button variant="ghost" size="icon" class="h-8 w-8" aria-label={translateMessage('dialog.closeInspector', interfaceLanguage)} onclick={close}><X class="h-4 w-4" /></Button>
    </div>
    {@render children?.()}
  </div>
</dialog>
{/if}
