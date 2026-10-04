<script lang="ts">
  import { Popover } from 'bits-ui';
  import { Copy } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import { showToast } from '#lib/ui.svelte';

  let { value, monospace = false, sensitive = false }: { value: string; monospace?: boolean; sensitive?: boolean } = $props();
  let open = $state(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      showToast('Copied to clipboard');
      open = false;
    } catch {
      showToast('Could not copy to clipboard', 'error');
    }
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger class="min-w-0 max-w-full truncate text-left underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" title={value} aria-label={`Show full value: ${value}`} data-sensitive={sensitive ? 'true' : undefined}>
    <span class={monospace ? 'font-mono' : ''}>{value}</span>
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content class="z-50 flex max-w-[min(90vw,28rem)] items-start gap-2 rounded-md border border-border bg-popover p-3 text-sm shadow-lg" sideOffset={6}>
      <span class="min-w-0 flex-1 break-all" class:font-mono={monospace} data-sensitive={sensitive ? 'true' : undefined}>{value}</span>
      <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" aria-label="Copy full value" onclick={() => void copy()}><Copy class="h-4 w-4" /></Button>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
