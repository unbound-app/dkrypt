<script lang="ts" generics="T">
  import { createVirtualizer, createWindowVirtualizer } from '@tanstack/svelte-virtual';
  import { get } from 'svelte/store';
  import { untrack, type Snippet } from 'svelte';
  import { cn } from '#lib/utils';

  interface Props<T> {
    items: T[];
    itemKey: (item: T) => string | number;
    estimateSize?: number | ((item: T) => number);
    overscan?: number;
    label: string;
    class?: string;
    style?: string;
    scrollMode?: 'element' | 'window';
    scrollElement?: HTMLDivElement;
    onScroll?: (event: Event) => void;
    children: Snippet<[T]>;
  }

  let {
    items,
    itemKey,
    estimateSize = 72,
    overscan = 8,
    label,
    class: className = '',
    style = '',
    scrollMode = 'element',
    scrollElement = $bindable(),
    onScroll,
    children,
  }: Props<T> = $props();
  let viewport = $state<HTMLDivElement | undefined>();
  let windowScrollMargin = $state(0);
  let virtualizerRevision = $state(0);

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport ?? null,
    estimateSize: () => typeof estimateSize === 'number' ? estimateSize : 72,
    overscan: 4,
    enabled: false,
  });
  const windowVirtualizer = createWindowVirtualizer<HTMLDivElement>({
    count: 0,
    estimateSize: () => typeof estimateSize === 'number' ? estimateSize : 72,
    overscan: 4,
    enabled: false,
  });

  $effect(() => {
    if (scrollMode === 'element' && scrollElement !== viewport) scrollElement = viewport;
  });

  $effect(() => {
    if (scrollMode !== 'window' || typeof window === 'undefined') return;
    const scrollViewport = viewport;
    let measuredWindowWidth = window.innerWidth;
    const updateScrollMargin = () => {
      if (!scrollViewport) return;
      if (window.innerWidth !== measuredWindowWidth) {
        measuredWindowWidth = window.innerWidth;
        $windowVirtualizer.measure();
      }
      const nextScrollMargin = Math.max(0, Math.round(scrollViewport.getBoundingClientRect().top + window.scrollY));
      if (nextScrollMargin !== untrack(() => windowScrollMargin)) windowScrollMargin = nextScrollMargin;
    };
    updateScrollMargin();
    window.addEventListener('scroll', updateScrollMargin, { passive: true });
    window.addEventListener('resize', updateScrollMargin);
    const parentObserver = typeof ResizeObserver === 'undefined' || !scrollViewport?.parentElement
      ? undefined
      : new ResizeObserver(updateScrollMargin);
    if (parentObserver && scrollViewport?.parentElement) parentObserver.observe(scrollViewport.parentElement);
    return () => {
      window.removeEventListener('scroll', updateScrollMargin);
      window.removeEventListener('resize', updateScrollMargin);
      parentObserver?.disconnect();
    };
  });

  function setVirtualizerOptions(
    rows: T[],
    scrollContainer: HTMLDivElement | undefined,
    rowEstimateSize: number | ((item: T) => number),
    rowOverscan: number,
    keyForItem: (item: T) => string | number,
    windowMargin: number,
    mode: 'element' | 'window',
  ): void {
    const itemOptions = {
      count: rows.length,
      estimateSize: (index: number) => {
        const item = rows[index];
        return item === undefined ? 72 : typeof rowEstimateSize === 'function' ? rowEstimateSize(item) : rowEstimateSize;
      },
      getItemKey: (index: number) => {
        const item = rows[index];
        return item === undefined ? index : keyForItem(item);
      },
      overscan: rowOverscan,
    };
    if (mode === 'window') {
      get(virtualizer).setOptions({ count: 0, enabled: false });
      get(windowVirtualizer).setOptions({ ...itemOptions, enabled: true, scrollMargin: windowMargin });
    } else {
      get(windowVirtualizer).setOptions({ count: 0, enabled: false });
      get(virtualizer).setOptions({
        ...itemOptions,
        enabled: true,
        getScrollElement: () => scrollContainer ?? null,
      });
    }
  }

  $effect(() => {
    const rows = items;
    const scrollContainer = viewport;
    const rowEstimateSize = estimateSize;
    const rowOverscan = overscan;
    const keyForItem = itemKey;
    const windowMargin = windowScrollMargin;
    const mode = scrollMode;
    setVirtualizerOptions(rows, scrollContainer, rowEstimateSize, rowOverscan, keyForItem, windowMargin, mode);
    untrack(() => virtualizerRevision += 1);
  });

  const totalSize = $derived.by(() => {
    virtualizerRevision;
    return scrollMode === 'window' ? $windowVirtualizer.getTotalSize() : $virtualizer.getTotalSize();
  });
  const virtualRows = $derived.by(() => {
    virtualizerRevision;
    return scrollMode === 'window' ? $windowVirtualizer.getVirtualItems() : $virtualizer.getVirtualItems();
  });

  function measureRow(element: HTMLDivElement): void {
    if (scrollMode === 'window') $windowVirtualizer.measureElement(element);
    else $virtualizer.measureElement(element);
  }

  function virtualizedListKeyboardScroll(element: HTMLDivElement, enabled: boolean): { update: (nextEnabled: boolean) => void; destroy: () => void } {
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.target !== element) return;
      let scrollTop = element.scrollTop;
      if (event.key === 'ArrowDown') scrollTop += 48;
      else if (event.key === 'ArrowUp') scrollTop -= 48;
      else if (event.key === 'PageDown') scrollTop += Math.max(48, element.clientHeight * 0.8);
      else if (event.key === 'PageUp') scrollTop -= Math.max(48, element.clientHeight * 0.8);
      else if (event.key === 'Home') scrollTop = 0;
      else if (event.key === 'End') scrollTop = element.scrollHeight;
      else return;
      event.preventDefault();
      element.scrollTo({ top: Math.max(0, Math.min(scrollTop, element.scrollHeight - element.clientHeight)) });
    };
    if (enabled) element.addEventListener('keydown', onKeydown);
    return {
      update: (nextEnabled) => {
        element.removeEventListener('keydown', onKeydown);
        if (nextEnabled) element.addEventListener('keydown', onKeydown);
      },
      destroy: () => element.removeEventListener('keydown', onKeydown),
    };
  }
</script>

<div bind:this={viewport} class={cn(className)} style={style} onscroll={onScroll} use:virtualizedListKeyboardScroll={scrollMode === 'element'} role="region" aria-label={scrollMode === 'window' ? `${label} list region` : `${label} scroll area`} tabindex={scrollMode === 'element' ? 0 : undefined}>
  <div class="relative w-full" style={`height:${totalSize}px`} role="list" aria-label={label}>
    {#each virtualRows as virtualRow (virtualRow.key)}
      {@const item = items[virtualRow.index]}
      {#if item !== undefined}
        <div
          class="absolute top-0 left-0 w-full"
          data-index={virtualRow.index}
          role="listitem"
          aria-posinset={virtualRow.index + 1}
          aria-setsize={items.length}
          use:measureRow
          style={`transform:translateY(${virtualRow.start - (scrollMode === 'window' ? windowScrollMargin : 0)}px)`}
        >
          {@render children(item)}
        </div>
      {/if}
    {/each}
  </div>
</div>
