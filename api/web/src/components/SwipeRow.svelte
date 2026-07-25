<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from '#lib/utils';

  let {
    open = false,
    onOpenChange,
    revealWidth = 96,
    class: className,
    children,
    actions,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    revealWidth?: number;
    class?: string;
    children?: Snippet;
    actions?: Snippet;
  } = $props();

  const DRAG_THRESHOLD = 8;
  const OPEN_THRESHOLD_RATIO = 0.4;

  let dragging = $state(false);
  let startX = 0;
  let startY = 0;
  let dragX = $state(0);
  let axisLocked: 'x' | 'y' | null = null;
  let pointerId: number | null = null;

  const offset = $derived(open ? -revealWidth : 0);
  const translateX = $derived(dragging ? Math.max(-revealWidth, Math.min(0, dragX)) : offset);

  function onPointerDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    dragging = true;
    axisLocked = null;
    startX = e.clientX;
    startY = e.clientY;
    dragX = offset;
    pointerId = e.pointerId;
  }

  function onPointerMove(e: PointerEvent): void {
    if (!dragging || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (axisLocked === null) {
      if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) return;
      axisLocked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axisLocked === 'x') (e.currentTarget as HTMLElement).setPointerCapture(pointerId);
    }

    if (axisLocked === 'y') {
      dragging = false;
      return;
    }

    e.preventDefault();
    dragX = offset + dx;
  }

  function endDrag(): void {
    if (!dragging) return;
    dragging = false;
    if (axisLocked === 'x' && revealWidth > 0) {
      const shouldOpen = translateX < -revealWidth * OPEN_THRESHOLD_RATIO;
      if (shouldOpen !== open) onOpenChange?.(shouldOpen);
    }
    axisLocked = null;
    pointerId = null;
  }

  function close(): void {
    if (open) onOpenChange?.(false);
  }
</script>

<div class={cn('relative overflow-hidden rounded-lg', className)}>
  <div class="absolute inset-y-0 right-0 flex items-stretch" style="width: {revealWidth}px">
    {@render actions?.()}
  </div>
  <div
    class="bg-panel-muted/40 relative touch-pan-y"
    style="transform: translateX({translateX}px); transition: {dragging ? 'none' : 'transform 180ms ease-out'};"
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={endDrag}
    onpointercancel={endDrag}
    onclick={() => open && close()}
    onkeydown={(e) => open && (e.key === 'Enter' || e.key === ' ') && close()}
    role="button"
    tabindex={open ? 0 : -1}
  >
    {@render children?.()}
  </div>
</div>
