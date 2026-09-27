<script lang="ts" generics="T">
  import { createVirtualizer } from '@tanstack/svelte-virtual';
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
    scrollElement = $bindable(),
    onScroll,
    children,
  }: Props<T> = $props();
  let viewport = $state<HTMLDivElement | undefined>();
  let virtualizerRevision = $state(0);

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: 0,
    getScrollElement: () => viewport ?? null,
    estimateSize: () => typeof estimateSize === 'number' ? estimateSize : 72,
    overscan: 8,
    enabled: true,
  });

  $effect(() => {
    if (scrollElement !== viewport) scrollElement = viewport;
  });

  function setVirtualizerOptions(
    rows: T[],
    scrollContainer: HTMLDivElement | undefined,
    rowEstimateSize: number | ((item: T) => number),
    rowOverscan: number,
    keyForItem: (item: T) => string | number,
  ): void {
    $virtualizer.setOptions({
      count: rows.length,
      enabled: true,
      getScrollElement: () => scrollContainer ?? null,
      estimateSize: (index) => {
        const item = rows[index];
        return item === undefined ? 72 : typeof rowEstimateSize === 'function' ? rowEstimateSize(item) : rowEstimateSize;
      },
      getItemKey: (index) => {
        const item = rows[index];
        return item === undefined ? index : keyForItem(item);
      },
      overscan: rowOverscan,
    });
  }

  $effect(() => {
    const rows = items;
    const scrollContainer = viewport;
    const rowEstimateSize = estimateSize;
    const rowOverscan = overscan;
    const keyForItem = itemKey;
    setVirtualizerOptions(rows, scrollContainer, rowEstimateSize, rowOverscan, keyForItem);
    untrack(() => virtualizerRevision += 1);
  });

  const totalSize = $derived.by(() => {
    virtualizerRevision;
    return $virtualizer.getTotalSize();
  });
  const virtualRows = $derived.by(() => {
    virtualizerRevision;
    return $virtualizer.getVirtualItems();
  });

  function measureRow(element: HTMLDivElement): void {
    $virtualizer.measureElement(element);
  }

  function virtualizedListKeyboardScroll(element: HTMLDivElement): { destroy: () => void } {
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
    element.addEventListener('keydown', onKeydown);
    return { destroy: () => element.removeEventListener('keydown', onKeydown) };
  }
</script>

<div bind:this={viewport} class={cn(className)} style={style} onscroll={onScroll} use:virtualizedListKeyboardScroll role="region" aria-label={`${label} scroll area`} tabindex="0">
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
          style={`transform:translateY(${virtualRow.start}px)`}
        >
          {@render children(item)}
        </div>
      {/if}
    {/each}
  </div>
</div>
