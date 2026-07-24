<script lang="ts">
  import { Check, Copy } from 'lucide-svelte';
  import { showToast } from '#lib/ui.svelte';
  import { cn } from '#lib/utils';

  let { text, label }: { text: string; label?: string } = $props();
  let copied = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1200);
    } catch {
      showToast("Couldn't copy - your browser blocked clipboard access", 'error', { track: false });
    }
  }
</script>

<button
  onclick={copy}
  class={cn(
    'border-border text-muted hover:text-text hover:border-accent inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md border',
    label ? 'h-7 px-2.5 text-xs' : 'h-6 w-6',
  )}
  aria-label={label ?? 'Copy'}
  title={label ?? 'Copy'}
>
  {#if copied}
    <Check class="text-ok h-3.5 w-3.5" />
  {:else}
    <Copy class="h-3.5 w-3.5" />
  {/if}
  {#if label}{copied ? 'Copied!' : label}{/if}
</button>
