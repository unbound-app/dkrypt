<script lang="ts">
  import { Inbox, type Icon as IconType } from 'lucide-svelte';
  import type { Snippet } from 'svelte';

  let { icon: Icon = Inbox, message, action }: { icon?: typeof IconType; message: string; action?: Snippet } = $props();
</script>

<div class="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted">
  <Icon class="h-6 w-6 opacity-60" />
  {message}
  {#if action}
    <div class="mt-1">
      {@render action()}
    </div>
  {/if}
</div>
