<script lang="ts">
  import { logout, sessionState } from '../lib/session.svelte';
  import { closePalette, paletteState, setActiveTab, setTheme, themeState } from '../lib/ui.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import Input from '../lib/components/ui/Input.svelte';
  import { cn } from '../lib/utils';

  interface Command {
    id: string;
    label: string;
    run: () => void;
  }

  let query = $state('');
  let selected = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  const commands = $derived.by((): Command[] => {
    const base: Command[] = [
      { id: 'home', label: 'Go to Home', run: () => setActiveTab('home') },
      { id: 'keys', label: 'Go to API Keys', run: () => setActiveTab('keys') },
      { id: 'logs', label: 'Go to Logs', run: () => setActiveTab('logs') },
      { id: 'docs', label: 'Go to Docs', run: () => setActiveTab('docs') },
    ];
    if (sessionState.role === 'admin') base.push({ id: 'settings', label: 'Go to Settings', run: () => setActiveTab('settings') });
    base.push({ id: 'theme', label: 'Toggle light / dark theme', run: () => setTheme(themeState.value === 'dark' ? 'light' : 'dark') });
    base.push({ id: 'logout', label: 'Log out', run: () => void logout() });
    return base;
  });

  const filtered = $derived(
    query.trim() === '' ? commands : commands.filter((c) => c.label.toLowerCase().includes(query.trim().toLowerCase())),
  );

  $effect(() => {
    filtered;
    selected = 0;
  });

  $effect(() => {
    if (paletteState.open) inputEl?.focus();
  });

  function run(cmd: Command): void {
    cmd.run();
    close();
  }

  function close(): void {
    query = '';
    closePalette();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = filtered[selected];
      if (cmd) run(cmd);
    }
  }
</script>

<Dialog open={paletteState.open} onOpenChange={(open) => !open && close()} class="top-[18vh] w-[90%] max-w-md translate-y-0 p-2">
  <Input bind:ref={inputEl} bind:value={query} onkeydown={onKeydown} placeholder="Type a command…" autofocus />
  <div class="mt-1.5 flex max-h-80 flex-col overflow-y-auto">
    {#each filtered as cmd, i (cmd.id)}
      <button
        class={cn('cursor-pointer rounded-md px-3 py-2.5 text-left text-sm text-text', i === selected && 'bg-accent/15')}
        onclick={() => run(cmd)}
      >
        {cmd.label}
      </button>
    {/each}
    {#if filtered.length === 0}
      <div class="px-3 py-2.5 text-sm text-muted">No matching commands.</div>
    {/if}
  </div>
</Dialog>
