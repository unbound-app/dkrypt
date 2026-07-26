<script lang="ts">
  import { cancelJob, fetchJobHistory, fetchMyKeys, fetchUsers, jobHistoryExportUrl, retryJob, triggerWatchDispatch, type JobHistoryEntry } from '#lib/api';
  import { addDecrypt, pushRecentBundleId } from '#lib/decrypts.svelte';
  import { debounce } from '#lib/format';
  import { PermissionFlag } from '#lib/permissions';
  import { logout, sessionCanSeeSettings, sessionHasPermission } from '#lib/session.svelte';
  import {
    closePalette,
    confirmDialog,
    jumpToHistoryBundleId,
    jumpToKeyUsage,
    jumpToUser,
    openHelp,
    paletteState,
    requestOpenBatch,
    setActiveTab,
    setSettingsSubtab,
    setTheme,
    showToast,
    themePrefState,
  } from '#lib/ui.svelte';
  import Dialog from '#lib/components/ui/Dialog.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import { liveState } from '#lib/live.svelte';
  import { cn } from '#lib/utils';
  import { rankCommands } from '#lib/commandSearch';

  interface Command {
    id: string;
    label: string;
    keywords?: string;
    category?: string;
    run: () => void;
  }

  let query = $state('');
  let selected = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();
  type RecentJob = Pick<JobHistoryEntry, 'id' | 'bundleId' | 'deviceId' | 'externalVersionId' | 'testflight' | 'versionLabel' | 'status'>;

  let recentJobs = $state<RecentJob[]>([]);
  let queryJobs = $state<RecentJob[]>([]);
  let myKeys = $state<{ id: string; name: string }[]>([]);
  let users = $state<{ username: string; displayName?: string }[]>([]);
  let recentIds = $state<string[]>([]);
  let historyQueryToken = 0;
  const RECENT_KEY = 'commandPaletteRecent';

  function loadRecents(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
    } catch {
      return [];
    }
  }

  function saveRecent(id: string): void {
    recentIds = [id, ...recentIds.filter((x) => x !== id)].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds));
  }

  $effect(() => {
    if (!paletteState.open) return;
    recentIds = loadRecents();
    void fetchJobHistory(0, 8).then((r) => {
      const seen = new Set<string>();
      const jobs: RecentJob[] = [];
      for (const h of r.history) {
        if (seen.has(h.bundleId)) continue;
        seen.add(h.bundleId);
        jobs.push({
          id: h.id,
          bundleId: h.bundleId,
          deviceId: h.deviceId,
          externalVersionId: h.externalVersionId,
          testflight: h.testflight,
          versionLabel: h.versionLabel,
          status: h.status,
        });
      }
      recentJobs = jobs;
    });
    void fetchMyKeys().then((r) => {
      myKeys = r.keys.map((k) => ({ id: k.id, name: k.name }));
    });
    if (sessionHasPermission(PermissionFlag.viewUsers) || sessionHasPermission(PermissionFlag.manageUsers)) {
      void fetchUsers().then((r) => {
        users = r.users.map((u) => ({ username: u.username, displayName: u.displayName }));
      });
    }
  });

  const searchJobHistory = debounce((q: string) => {
    const token = ++historyQueryToken;
    void fetchJobHistory(0, 5, q).then((r) => {
      if (!paletteState.open || query.trim() !== q || token !== historyQueryToken) return;
      const seen = new Set<string>();
      const jobs: RecentJob[] = [];
      for (const h of r.history) {
        if (seen.has(h.bundleId)) continue;
        seen.add(h.bundleId);
        jobs.push({
          id: h.id,
          bundleId: h.bundleId,
          deviceId: h.deviceId,
          externalVersionId: h.externalVersionId,
          testflight: h.testflight,
          versionLabel: h.versionLabel,
          status: h.status,
        });
      }
      queryJobs = jobs;
    });
  }, 250);

  $effect(() => {
    const q = query.trim();
    if (!paletteState.open || q.length < 2) {
      queryJobs = [];
      return;
    }
    searchJobHistory(q);
  });

  async function cancelAllJobs(): Promise<void> {
    const jobs = liveState.overview?.activeJobs ?? [];
    if (jobs.length === 0) return;
    if (!(await confirmDialog(`Cancel all ${jobs.length} active job(s)?`, { confirmLabel: 'Cancel all' }))) return;
    await Promise.all(jobs.map((j) => cancelJob(j.id)));
  }

  async function cancelActiveJob(id: string, bundleId: string): Promise<void> {
    if (!(await confirmDialog(`Cancel ${bundleId}?`, { confirmLabel: 'Cancel job' }))) return;
    const { ok } = await cancelJob(id);
    if (ok) showToast(`Cancelled ${bundleId}`, 'success');
  }

  async function retryRecentJob(job: RecentJob): Promise<void> {
    const { ok, data } = await retryJob(job.id);
    if (!ok) return;
    addDecrypt({
      id: data.id,
      bundleId: job.bundleId,
      trackName: job.bundleId,
      versionLabel: job.versionLabel,
      externalVersionId: job.externalVersionId,
      testflight: job.testflight,
      status: data.status,
      progress: data.progress,
      queue: data.queue,
    });
    pushRecentBundleId(job.bundleId);
    showToast(`Retrying ${job.bundleId}`, 'success');
  }

  async function runTriggerWatchDispatch(watchId: string): Promise<void> {
    const { ok, data } = await triggerWatchDispatch(watchId);
    if (ok) showToast('Dispatch check triggered - watch Active Jobs / Logs for progress', 'success');
    else showToast(data.error ?? 'Failed to trigger', 'error');
  }

  const commands = $derived.by((): Command[] => {
    const base: Command[] = [
      { id: 'home', label: 'Go to Home', category: 'Navigation', run: () => setActiveTab('home') },
      { id: 'billing', label: 'Go to Plans', category: 'Navigation', run: () => setActiveTab('billing') },
      { id: 'keys', label: 'Go to API Keys', category: 'Navigation', run: () => setActiveTab('keys') },
    ];
    if (sessionHasPermission(PermissionFlag.viewLogs)) {
      base.push({ id: 'logs', label: 'Go to Logs', category: 'Navigation', run: () => setActiveTab('logs') });
    }
    base.push({ id: 'insights', label: 'Go to Insights', category: 'Navigation', run: () => setActiveTab('insights') });
    base.push({ id: 'docs', label: 'Go to Docs', category: 'Navigation', run: () => setActiveTab('docs') });
    if (sessionCanSeeSettings()) {
      base.push({ id: 'settings', label: 'Go to Settings', category: 'Navigation', run: () => setActiveTab('settings') });
    }
    if (sessionHasPermission(PermissionFlag.manageRoles)) {
      base.push({
        id: 'settings-roles',
        label: 'Go to role management (Discord perks)',
        category: 'Navigation',
        keywords: 'discord perks roles',
        run: () => {
          setActiveTab('settings');
          setSettingsSubtab('roles');
        },
      });
    }
    const THEME_CYCLE = ['dark', 'light', 'auto'] as const;
    base.push({
      id: 'theme',
      label: 'Cycle theme (dark / light / auto)',
      category: 'Preferences',
      run: () => setTheme(THEME_CYCLE[(THEME_CYCLE.indexOf(themePrefState.value) + 1) % THEME_CYCLE.length]),
    });
    base.push({ id: 'shortcuts', label: 'Show keyboard shortcuts', category: 'Help', run: () => openHelp() });

    if (sessionHasPermission(PermissionFlag.requestDecrypt)) {
      base.push({ id: 'batch-decrypt', label: 'Open batch decrypt', category: 'Actions', run: () => requestOpenBatch() });
      const activeCount = liveState.overview?.activeJobs.length ?? 0;
      if (activeCount > 0) {
        base.push({ id: 'cancel-all', label: `Cancel all ${activeCount} active job(s)`, category: 'Actions', run: () => void cancelAllJobs() });
        for (const job of liveState.overview?.activeJobs ?? []) {
          base.push({
            id: `cancel-${job.id}`,
            label: `Cancel ${job.bundleId}`,
            category: 'Actions',
            keywords: `${job.bundleId} active job`,
            run: () => void cancelActiveJob(job.id, job.bundleId),
          });
        }
      }
    }
    if (sessionHasPermission(PermissionFlag.manageAutomation)) {
      for (const w of liveState.overview?.watches ?? []) {
        if (!w.schedulable) continue;
        base.push({
          id: `trigger-dispatch-${w.id}`,
          label: `Trigger dispatch now: ${w.name ?? w.bundleId}`,
          category: 'Actions',
          keywords: w.bundleId,
          run: () => void runTriggerWatchDispatch(w.id),
        });
      }
    }
    base.push({
      id: 'export-history-csv',
      label: 'Export job history as CSV',
      category: 'Exports',
      run: () => window.open(jobHistoryExportUrl('csv'), '_blank'),
    });
    base.push({
      id: 'export-history-json',
      label: 'Export job history as JSON',
      category: 'Exports',
      run: () => window.open(jobHistoryExportUrl('json'), '_blank'),
    });

    base.push({ id: 'logout', label: 'Log out', category: 'Session', run: () => void logout() });

    const devices = liveState.overview?.devices ?? [];
    const showDevice = devices.length > 1;
    const seenJobs = new Set<string>();
    for (const job of [...recentJobs, ...queryJobs]) {
      if (seenJobs.has(job.bundleId)) continue;
      seenJobs.add(job.bundleId);
      const deviceName = showDevice ? devices.find((d) => d.id === job.deviceId)?.name : undefined;
      base.push({
        id: `job-${job.bundleId}`,
        label: `Jump to ${job.bundleId} in Job History${deviceName ? ` (${deviceName})` : ''}`,
        category: 'Navigation',
        keywords: job.bundleId,
        run: () => jumpToHistoryBundleId(job.bundleId),
      });
      if (sessionHasPermission(PermissionFlag.requestDecrypt) && job.status === 'failed') {
        base.push({
          id: `retry-${job.id}`,
          label: `Retry failed job: ${job.bundleId}`,
          category: 'Actions',
          keywords: `${job.bundleId} retry failed`,
          run: () => void retryRecentJob(job),
        });
      }
    }
    for (const key of myKeys) {
      base.push({
        id: `key-${key.id}`,
        label: `View usage for API key "${key.name}"`,
        category: 'Navigation',
        keywords: key.name,
        run: () => jumpToKeyUsage(key.id),
      });
    }
    for (const u of users) {
      base.push({
        id: `user-${u.username}`,
        label: `Jump to user "${u.displayName || u.username}"`,
        category: 'Navigation',
        keywords: `${u.username} ${u.displayName ?? ''}`,
        run: () => jumpToUser(u.username),
      });
    }

    return base;
  });

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return rankCommands(commands, q, recentIds);
  });

  $effect(() => {
    filtered;
    selected = 0;
  });

  $effect(() => {
    if (paletteState.open) inputEl?.focus();
  });

  function run(cmd: Command): void {
    saveRecent(cmd.id);
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
        <div>{cmd.label}</div>
        {#if cmd.category}
          <div class="text-[11px] text-muted">{cmd.category}</div>
        {/if}
      </button>
    {/each}
    {#if filtered.length === 0}
      <div class="px-3 py-2.5 text-sm text-muted">No matching commands.</div>
    {/if}
  </div>
</Dialog>
