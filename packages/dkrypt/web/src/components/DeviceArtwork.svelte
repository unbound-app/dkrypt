<script lang="ts">
  import { Apple } from 'lucide-svelte';
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

<div class={cn('flex h-14 w-12 shrink-0 items-center justify-center', className)} aria-hidden="true">
  {#if kind === 'ipad'}
    <div class="relative h-12 w-9 rounded-[0.65rem] border border-white/60 bg-slate-950 p-0.5 shadow-md shadow-slate-950/20">
      <div class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[0.5rem] bg-[linear-gradient(145deg,#0f172a_0%,#2563eb_48%,#14b8a6_100%)]">
        <div class="absolute -top-3 -right-2 size-8 rounded-full bg-cyan-300/35 blur-md"></div>
        <div class="absolute -bottom-3 -left-2 size-8 rounded-full bg-blue-400/35 blur-md"></div>
        <Apple class="relative size-4 text-white/90" strokeWidth={1.7} />
      </div>
    </div>
  {:else if kind === 'iphone'}
    <div class="relative h-12 w-6 rounded-[0.6rem] border border-white/60 bg-slate-950 p-0.5 shadow-md shadow-slate-950/20">
      <div class="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[0.45rem] bg-[linear-gradient(160deg,#111827_0%,#7c3aed_48%,#ec4899_100%)]">
        <div class="absolute top-0.5 left-1/2 h-1 w-2 -translate-x-1/2 rounded-full bg-black/65"></div>
        <Apple class="relative size-3.5 text-white/90" strokeWidth={1.7} />
      </div>
    </div>
  {:else if kind === 'ipod'}
    <div class="relative h-11 w-6 rounded-[0.55rem] border border-white/60 bg-slate-950 p-0.5 shadow-md shadow-slate-950/20">
      <div class="flex h-full w-full items-center justify-center rounded-[0.4rem] bg-[linear-gradient(160deg,#1e293b_0%,#475569_55%,#0f172a_100%)]">
        <Apple class="size-3.5 text-white/90" strokeWidth={1.7} />
      </div>
    </div>
  {:else}
    <div class="flex size-11 items-center justify-center rounded-xl bg-gradient-to-br from-slate-900 via-blue-700 to-cyan-500 shadow-md shadow-blue-950/20">
      <Apple class="size-5 text-white/90" strokeWidth={1.7} />
    </div>
  {/if}
</div>
