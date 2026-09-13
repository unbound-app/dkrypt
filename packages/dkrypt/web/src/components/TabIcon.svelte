<script lang="ts">
  import { BarChart3, BookOpen, Home, KeyRound, ScrollText, Settings, Wallet } from 'lucide-svelte';
  import type { TabId } from '#lib/ui.svelte';

  interface Props {
    id: TabId;
    class?: string;
  }

  let { id, class: className }: Props = $props();
</script>

{#if id === 'home'}
  <Home class={className} aria-hidden="true" />
{:else if id === 'billing'}
  <Wallet class={className} aria-hidden="true" />
{:else if id === 'keys'}
  <KeyRound class={className} aria-hidden="true" />
{:else if id === 'logs'}
  <ScrollText class={className} aria-hidden="true" />
{:else if id === 'insights'}
  <BarChart3 class={className} aria-hidden="true" />
{:else if id === 'docs'}
  <BookOpen class={className} aria-hidden="true" />
{:else}
  <Settings class={className} aria-hidden="true" />
{/if}
