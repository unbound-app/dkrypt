<script lang="ts">
  import { TabletSmartphone } from 'lucide-svelte';
  import { getAppleDeviceArtworkVariant } from '#lib/deviceModel';
  import { cn } from '#lib/utils';

  interface Props {
    productType?: string;
    name?: string;
    class?: string;
  }

  let { productType, name, class: className }: Props = $props();
  const variant = $derived(getAppleDeviceArtworkVariant(productType, name));
  const isTablet = $derived(variant === 'ipad' || variant === 'ipad-mini');
  const isMini = $derived(variant === 'ipad-mini');
  const isLargePhone = $derived(variant === 'iphone-large');
  const isPhone = $derived(variant === 'iphone' || isLargePhone || variant === 'ipod');
  const tabletX = $derived(isMini ? 8 : 4);
  const tabletWidth = $derived(isMini ? 32 : 40);
  const screenX = $derived(tabletX + 2.5);
  const screenWidth = $derived(tabletWidth - 5);
  const phoneWidth = $derived(isLargePhone ? 24 : variant === 'ipod' ? 20 : 22);
  const phoneX = $derived((48 - phoneWidth) / 2);
  const phoneScreenX = $derived(phoneX + 2.5);
  const phoneScreenWidth = $derived(phoneWidth - 5);
</script>

<div class={cn('text-muted flex h-14 w-12 shrink-0 items-center justify-center', className)} aria-hidden="true">
  {#if isTablet}
    <svg viewBox="0 0 48 64" class="h-14 w-12" fill="none">
      <rect x={tabletX} y="2" width={tabletWidth} height="60" rx={isMini ? 5.5 : 4.5} fill="currentColor" fill-opacity="0.035" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.4" />
      <rect x={screenX} y="5" width={screenWidth} height="54" rx="2.5" fill="currentColor" fill-opacity="0.055" stroke="currentColor" stroke-opacity="0.2" stroke-width="0.8" />
      <path d="M{screenX + 3} 39c4-6 8-9 14-11M{screenX + 3} 45c5-4 10-6 17-7" stroke="currentColor" stroke-opacity="0.2" stroke-linecap="round" stroke-width="1.2" />
    </svg>
  {:else if isPhone}
    <svg viewBox="0 0 48 64" class="h-14 w-10" fill="none">
      <rect x={phoneX} y="2" width={phoneWidth} height="60" rx="5.5" fill="currentColor" fill-opacity="0.035" stroke="currentColor" stroke-opacity="0.65" stroke-width="1.4" />
      <rect x={phoneScreenX} y="5" width={phoneScreenWidth} height="54" rx="3.5" fill="currentColor" fill-opacity="0.055" stroke="currentColor" stroke-opacity="0.2" stroke-width="0.8" />
      <path d="M{phoneScreenX + 2} 40c2.5-5 5-8 9-10M{phoneScreenX + 2} 46c3-3.5 5.5-5.5 10-6.5" stroke="currentColor" stroke-opacity="0.2" stroke-linecap="round" stroke-width="1.1" />
    </svg>
  {:else}
    <TabletSmartphone class="size-9" strokeWidth={1.5} />
  {/if}
</div>
