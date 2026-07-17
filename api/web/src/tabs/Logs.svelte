<script lang="ts">
  import { ScrollText, X } from 'lucide-svelte';
  import CopyButton from '../components/CopyButton.svelte';
  import EmptyState from '../components/EmptyState.svelte';
  import RelativeTime from '../components/RelativeTime.svelte';
  import { fetchLogs, type LogEntry } from '../lib/api';
  import Badge from '../lib/components/ui/Badge.svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import Input from '../lib/components/ui/Input.svelte';
  import Select from '../lib/components/ui/Select.svelte';
  import type { BadgeVariant } from '../lib/components/ui/variants';
  import { csvCell, downloadBlob } from '../lib/format';
  import { liveState } from '../lib/live.svelte';
  import { cn } from '../lib/utils';

  const LEVEL_BORDER: Record<LogEntry['level'], string> = {
    info: 'border-l-accent',
    warn: 'border-l-warn',
    error: 'border-l-err',
  };

  let scopeFilter = $state(localStorage.getItem('logScopeFilter') ?? 'all');
  let levelFilter = $state(localStorage.getItem('logLevelFilter') ?? 'all');
  let searchText = $state('');
  let regexMode = $state(localStorage.getItem('logRegexMode') === 'true');
  let autoScroll = $state(localStorage.getItem('logAutoScroll') !== 'false');
  let initialLogs = $state<LogEntry[] | null>(null);
  let listEl: HTMLDivElement | undefined = $state();
  let stickToTop = $state(true);

  function onListScroll(): void {
    if (!listEl) return;
    stickToTop = listEl.scrollTop <= 4;
  }

  const LEVEL_OPTIONS = [
    { value: 'all', label: 'All levels' },
    { value: 'info', label: 'Info' },
    { value: 'warn', label: 'Warnings' },
    { value: 'error', label: 'Errors' },
  ];

  const LEVEL_BADGE: Record<LogEntry['level'], BadgeVariant> = {
    info: 'default',
    warn: 'warning',
    error: 'destructive',
  };

  $effect(() => {
    void fetchLogs().then((d) => {
      initialLogs = d.logs;
    });
  });

  $effect(() => {
    localStorage.setItem('logScopeFilter', scopeFilter);
  });
  $effect(() => {
    localStorage.setItem('logLevelFilter', levelFilter);
  });
  $effect(() => {
    localStorage.setItem('logAutoScroll', String(autoScroll));
  });
  $effect(() => {
    localStorage.setItem('logRegexMode', String(regexMode));
  });

  const regexError = $derived.by(() => {
    if (!regexMode || !searchText.trim()) return null;
    try {
      new RegExp(searchText);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });

  function matchesSearch(l: LogEntry): boolean {
    const q = searchText.trim();
    if (!q) return true;
    if (regexMode) {
      if (regexError) return false;
      const re = new RegExp(q, 'i');
      return re.test(l.message) || re.test(fmtLogMeta(l.meta));
    }
    return l.message.toLowerCase().includes(q.toLowerCase()) || fmtLogMeta(l.meta).toLowerCase().includes(q.toLowerCase());
  }

  function entryKey(l: LogEntry): string {
    return `${l.ts}-${l.scope}-${l.level}-${l.message}`;
  }

  const combined = $derived.by((): LogEntry[] => {
    const seen = new Set<string>();
    const merged: LogEntry[] = [];
    for (const l of liveState.logs) {
      const key = entryKey(l);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(l);
      }
    }
    for (const l of initialLogs ?? []) {
      const key = entryKey(l);
      if (!seen.has(key)) {
        seen.add(key);
        merged.push(l);
      }
    }
    return merged;
  });

  function exportCsv(): void {
    const rows = ['ts,level,scope,message,meta'];
    for (const l of filtered) {
      rows.push([new Date(l.ts).toISOString(), l.level, l.scope, l.message, fmtLogMeta(l.meta)].map(csvCell).join(','));
    }
    downloadBlob(rows.join('\n'), 'dkrypt-logs.csv', 'text/csv');
  }

  function exportJson(): void {
    downloadBlob(JSON.stringify(filtered, null, 2), 'dkrypt-logs.json', 'application/json');
  }

  function fmtLogMeta(meta?: Record<string, unknown>): string {
    if (!meta) return '';
    return Object.entries(meta)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
  }

  const scopes = $derived([...new Set(combined.map((l) => l.scope))].sort());

  const filtered = $derived(
    combined.filter(
      (l) => (scopeFilter === 'all' || l.scope === scopeFilter) && (levelFilter === 'all' || l.level === levelFilter) && matchesSearch(l),
    ),
  );

  $effect(() => {
    filtered;
    if (autoScroll && stickToTop && listEl) listEl.scrollTop = 0;
  });

  // Tracks the newest entry the user has actually seen at the top of the list - used to show a
  // "jump to latest" pill when they're scrolled away (or auto-scroll is off) and more arrive.
  let pinnedTopKey = $state<string | undefined>(undefined);

  $effect(() => {
    if (stickToTop) pinnedTopKey = filtered[0] ? entryKey(filtered[0]) : undefined;
  });

  $effect(() => {
    scopeFilter;
    levelFilter;
    searchText;
    pinnedTopKey = filtered[0] ? entryKey(filtered[0]) : undefined;
  });

  const hasNewer = $derived(!stickToTop && filtered.length > 0 && entryKey(filtered[0]) !== pinnedTopKey);

  function jumpToLatest(): void {
    if (listEl) listEl.scrollTop = 0;
    pinnedTopKey = filtered[0] ? entryKey(filtered[0]) : undefined;
  }
</script>

<Card title="Scheduler &amp; job logs">
  <div class="mb-3.5 flex flex-wrap items-center gap-2.5">
    <div class="flex flex-wrap gap-1">
      <Button variant={scopeFilter === 'all' ? 'default' : 'secondary'} size="sm" onclick={() => (scopeFilter = 'all')}>All</Button>
      {#each scopes as scope (scope)}
        <Button variant={scopeFilter === scope ? 'default' : 'secondary'} size="sm" onclick={() => (scopeFilter = scope)}>{scope}</Button>
      {/each}
    </div>
    <Select items={LEVEL_OPTIONS} bind:value={levelFilter} class="w-36" />
    <div>
      <div class="relative w-44">
        <Input
          placeholder={regexMode ? 'Search logs (regex)…' : 'Search logs…'}
          bind:value={searchText}
          class={cn(searchText ? 'pr-8' : '', regexError ? 'border-err!' : '')}
        />
        {#if searchText}
          <button
            class="text-muted hover:text-text absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer"
            onclick={() => (searchText = '')}
            aria-label="Clear search"
            title="Clear search"
          >
            <X class="h-3.5 w-3.5" />
          </button>
        {/if}
      </div>
      {#if regexError}
        <div class="mt-1 text-xs text-err">{regexError}</div>
      {/if}
    </div>
    <button
      class={cn(
        'h-9 shrink-0 cursor-pointer rounded-md border px-2.5 font-mono text-xs',
        regexMode ? 'border-accent bg-accent/15 text-accent' : 'border-border text-muted hover:text-text',
      )}
      onclick={() => (regexMode = !regexMode)}
      aria-pressed={regexMode}
      title={regexMode ? 'Regex search on - click for plain substring search' : 'Plain substring search - click for regex'}
    >
      .*
    </button>
    <div class="ml-auto flex items-center gap-2.5">
      <Button variant="secondary" size="sm" onclick={exportCsv}>Export CSV</Button>
      <Button variant="secondary" size="sm" onclick={exportJson}>Export JSON</Button>
      <label class="flex items-center gap-1.5 text-xs text-muted">
        <input type="checkbox" bind:checked={autoScroll} />
        Auto-scroll to newest
      </label>
    </div>
  </div>

  {#if initialLogs === null}
    <div class="flex flex-col gap-1.5">
      {#each Array(6) as _, i (i)}
        <div class="skeleton bg-panel-muted h-8 rounded-md"></div>
      {/each}
    </div>
  {:else}
    <div class="relative">
      {#if hasNewer}
        <button
          class="border-accent bg-accent text-accent-contrast absolute top-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium shadow-lg"
          onclick={jumpToLatest}
        >
          New log lines - jump to latest
        </button>
      {/if}
      <div class="flex max-h-[560px] flex-col gap-1.5 overflow-y-auto" bind:this={listEl} onscroll={onListScroll}>
        {#each filtered as l (entryKey(l))}
          <div class={`border-border bg-panel-muted flex items-baseline gap-2 rounded-md border border-l-[3px] px-2.5 py-2 text-[12.5px] ${LEVEL_BORDER[l.level]}`}>
            <span class="shrink-0 font-mono text-[11.5px] whitespace-nowrap text-muted"><RelativeTime ms={l.ts} /></span>
            <Badge variant={LEVEL_BADGE[l.level]} class="shrink-0">{l.level}</Badge>
            <Badge variant="secondary" class="shrink-0">{l.scope}</Badge>
            <span class="min-w-0 flex-1 truncate" title="{l.message} {fmtLogMeta(l.meta)}">
              {l.message}
              {#if l.meta}
                <span class="font-mono text-[11px] text-muted">{fmtLogMeta(l.meta)}</span>
              {/if}
            </span>
            <CopyButton text={JSON.stringify(l, null, 2)} label="JSON" />
          </div>
        {/each}
      </div>
    </div>
    {#if filtered.length === 0}
      <EmptyState icon={ScrollText} message="No log entries yet." />
    {/if}
  {/if}
</Card>
