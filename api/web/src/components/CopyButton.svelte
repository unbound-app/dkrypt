<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';

  let { text }: { text: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1200);
    } catch {}
  }
</script>

<button
  onclick={copy}
  class="border-border text-muted hover:text-text hover:border-accent inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md border"
  aria-label="Copy"
  title="Copy"
>
  {#if copied}
    <Check class="text-ok h-3.5 w-3.5" />
  {:else}
    <Copy class="h-3.5 w-3.5" />
  {/if}
</button>
