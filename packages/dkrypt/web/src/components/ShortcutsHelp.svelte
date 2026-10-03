<script lang="ts">
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import { closeHelp, helpState } from '#lib/ui.svelte';
  import { shortcutBindingsState } from '#lib/shortcuts.svelte';

  const shortcuts = $derived([
    { keys: shortcutBindingsState.value.focusSearch, description: 'Focus the App Store search on Home' },
    { keys: shortcutBindingsState.value.batch, description: 'Open batch decrypt (on Home)' },
    { keys: `${shortcutBindingsState.value.jumpPrefix} then ${['home', 'billing', 'keys', 'logs', 'insights', 'docs', 'settings'].map((key) => shortcutBindingsState.value[key as keyof typeof shortcutBindingsState.value]).join('/')}`, description: 'Jump to Home/Billing/Keys/Logs/Insights/Docs/Settings' },
    { keys: shortcutBindingsState.value.palette.replace('Mod', 'Ctrl/Cmd'), description: 'Open the command palette' },
    { keys: 'Enter', description: 'Submit the focused form or search' },
    { keys: '↑ / ↓', description: 'Move through palette or search results' },
    { keys: 'Esc', description: 'Close the open dialog' },
    { keys: shortcutBindingsState.value.help, description: 'Show this shortcuts list' },
  ]);
</script>

<Dialog open={helpState.open} onOpenChange={(open) => !open && closeHelp()} class="max-w-sm">
  <h2 class="mb-3 text-sm font-semibold text-text">Keyboard shortcuts</h2>
  <dl class="flex flex-col gap-2">
    {#each shortcuts as s (s.description)}
      <div class="flex items-center justify-between gap-3 text-sm">
        <dt class="text-muted">{s.description}</dt>
        <dd class="border-border bg-panel-muted shrink-0 rounded-md border px-2 py-0.5 font-mono text-xs">{s.keys}</dd>
      </div>
    {/each}
  </dl>
</Dialog>
