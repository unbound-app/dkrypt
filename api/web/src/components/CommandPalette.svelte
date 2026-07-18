<script lang="ts">
  import { cancelJob, fetchJobHistory, fetchMyKeys, jobHistoryExportUrl, triggerWatchDispatch } from '../lib/api';
  import { logout, sessionState } from '../lib/session.svelte';
  import {
    closePalette,
    confirmDialog,
    jumpToHistoryBundleId,
    jumpToKeyUsage,
    openHelp,
    paletteState,
    requestOpenBatch,
    setActiveTab,
    setTheme,
    showToast,
    themePrefState,
  } from '../lib/ui.svelte';
  import Dialog from '../lib/components/ui/Dialog.svelte';
  import Input from '../lib/components/ui/Input.svelte';
  import { liveState } from '../lib/live.svelte';
  import { cn } from '../lib/utils';

  interface Command {
    id: string;
    label: string;
    keywords?: string;
    run: () => void;
  }

  let query = $state('');
  let selected = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();
  let recentBundleIds = $state<string[]>([]);
  let myKeys = $state<{ id: string; name: string }[]>([]);

  $effect(() => {
    if (!paletteState.open) return;
    void fetchJobHistory(0, 8).then((r) => {
      recentBundleIds = [...new Set(r.history.map((h) => h.bundleId))];
    });
    void fetchMyKeys().then((r) => {
      myKeys = r.keys.map((k) => ({ id: k.id, name: k.name }));
    });
  });

  async function cancelAllJobs(): Promise<void> {
    const jobs = liveState.overview?.activeJobs ?? [];
    if (jobs.length === 0) return;
    if (!(await confirmDialog(`Cancel all ${jobs.length} active job(s)?`, { confirmLabel: 'Cancel all' }))) return;
    await Promise.all(jobs.map((j) => cancelJob(j.id)));
  }

  async function runTriggerWatchDispatch(watchId: string): Promise<void> {
    const { ok, data } = await triggerWatchDispatch(watchId);
    if (ok) showToast('Dispatch check triggered - watch Active Jobs / Logs for progress', 'success');
    else showToast(data.error ?? 'Failed to trigger', 'error');
  }

  const commands = $derived.by((): Command[] => {
    const base: Command[] = [
      { id: 'home', label: 'Go to Home', run: () => setActiveTab('home') },
      { id: 'keys', label: 'Go to API Keys', run: () => setActiveTab('keys') },
    ];
    if (sessionState.permissions?.viewLogs) {
      base.push({ id: 'logs', label: 'Go to Logs', run: () => setActiveTab('logs') });
    }
    base.push({ id: 'insights', label: 'Go to Insights', run: () => setActiveTab('insights') });
    base.push({ id: 'docs', label: 'Go to Docs', run: () => setActiveTab('docs') });
    if (
      sessionState.permissions?.manageScheduler ||
      sessionState.permissions?.triggerDispatch ||
      sessionState.permissions?.manageAppleAuth ||
      sessionState.permissions?.viewUsers ||
      sessionState.permissions?.manageUsers
    ) {
      base.push({ id: 'settings', label: 'Go to Settings', run: () => setActiveTab('settings') });
    }
    const THEME_CYCLE = ['dark', 'light', 'auto'] as const;
    base.push({
      id: 'theme',
      label: 'Cycle theme (dark / light / auto)',
      run: () => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themePrefState.value) + 1) % THEME_CYCLE.length]),
    });
    base.push({ id: 'shortcuts', label: 'Show keyboard shortcuts', run: () => openHelp() });

    if (sessionState.permissions?.decrypt) {
      base.push({ id: 'batch-decrypt', label: 'Open batch decrypt', run: () => requestOpenBatch() });
      const activeCount = liveState.overview?.activeJobs.length ?? 0;
      if (activeCount > 0) {
        base.push({ id: 'cancel-all', label: `Cancel all ${activeCount} active job(s)`, run: () => void cancelAllJobs() });
      }
    }
    if (sessionState.permissions?.triggerDispatch) {
      for (const w of liveState.overview?.watches ?? []) {
        if (!w.schedulable) continue;
        base.push({
          id: `trigger-dispatch-${w.id}`,
          label: `Trigger dispatch now: ${w.name ?? w.bundleId}`,
          keywords: w.bundleId,
          run: () => void runTriggerWatchDispatch(w.id),
        });
      }
    }
    base.push({ id: 'export-history-csv', label: 'Export job history as CSV', run: () => window.open(jobHistoryExportUrl('csv'), '_blank') });
    base.push({ id: 'export-history-json', label: 'Export job history as JSON', run: () => window.open(jobHistoryExportUrl('json'), '_blank') });

    base.push({ id: 'logout', label: 'Log out', run: () => void logout() });

    for (const bundleId of recentBundleIds) {
      base.push({
        id: `job-${bundleId}`,
        label: `Jump to ${bundleId} in Job History`,
        keywords: bundleId,
        run: () => jumpToHistoryBundleId(bundleId),
      });
    }
    for (const key of myKeys) {
      base.push({ id: `key-${key.id}`, label: `View usage for API key "${key.name}"`, keywords: key.name, run: () => jumpToKeyUsage(key.id) });
    }

    return base;
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.keywords?.toLowerCase().includes(q));
  });

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
