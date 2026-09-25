<script lang="ts">
  import { Smartphone, Tablet, TabletSmartphone } from 'lucide-svelte';
  import { getAppleDeviceKind } from '#lib/deviceModel';
  import { cn } from '#lib/utils';

  interface Props {
    productType?: string;
    name?: string;
    class?: string;
  }

  let { productType, name, class: className }: Props = $props();
  const kind = $derived(getAppleDeviceKind(productType, name));
</script>

<div class={cn('text-muted flex h-14 w-12 shrink-0 items-center justify-center', className)} aria-hidden="true">
  {#if kind === 'ipad'}
    <Tablet class="size-10" strokeWidth={1.5} />
  {:else if kind === 'iphone' || kind === 'ipod'}
    <Smartphone class="size-8" strokeWidth={1.5} />
  {:else}
    <TabletSmartphone class="size-9" strokeWidth={1.5} />
  {/if}
</div>
