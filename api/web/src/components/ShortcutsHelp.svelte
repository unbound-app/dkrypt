<script lang="ts">
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { closeHelp, helpState } from '#lib/ui.svelte';

  const SHORTCUTS: { keys: string; description: string }[] = [
    { keys: '/', description: 'Focus the App Store search on Home' },
    { keys: 'b', description: 'Open batch decrypt (on Home)' },
    { keys: 'g then h/b/k/l/i/d/s', description: 'Jump to Home/Billing/Keys/Logs/Insights/Docs/Settings' },
    { keys: 'Ctrl/Cmd + K', description: 'Open the command palette' },
    { keys: 'Enter', description: 'Submit the focused form or search' },
    { keys: '↑ / ↓', description: 'Move through palette or search results' },
    { keys: 'Esc', description: 'Close the open dialog' },
    { keys: '?', description: 'Show this shortcuts list' },
  ];
</script>

<Dialog open={helpState.open} onOpenChange={(open) => !open && closeHelp()} class="max-w-sm">
  <h2 class="mb-3 text-sm font-semibold text-text">Keyboard shortcuts</h2>
  <dl class="flex flex-col gap-2">
    {#each SHORTCUTS as s (s.keys)}
      <div class="flex items-center justify-between gap-3 text-sm">
        <dt class="text-muted">{s.description}</dt>
        <dd class="border-border bg-panel-muted shrink-0 rounded-md border px-2 py-0.5 font-mono text-xs">{s.keys}</dd>
      </div>
    {/each}
  </dl>
</Dialog>
