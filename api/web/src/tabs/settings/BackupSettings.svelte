<script lang="ts">
  import { Download, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import EmptyState from '../../components/EmptyState.svelte';
  import {
    backupExportUrl,
    backupSnapshotDownloadUrl,
    createBackupSnapshot,
    deleteBackupSnapshot,
    fetchBackupHistory,
    fetchBackupSchedule,
    importBackup,
    previewBackup,
    updateBackupSchedule,
    validateCron,
    type BackupHistoryEntry,
    type BackupPreviewSummary,
    type BackupScheduleSettings,
  } from '../../lib/api';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import Switch from '../../lib/components/ui/Switch.svelte';
  import { buttonVariants } from '../../lib/components/ui/variants';
  import { debounce, fmtRelative, fmtSize, fmtTime } from '../../lib/format';
  import { PermissionFlag } from '../../lib/permissions';
  import { sessionHasPermission } from '../../lib/session.svelte';
  import { confirmDialog } from '../../lib/ui.svelte';

  const canManageBackup = $derived(sessionHasPermission(PermissionFlag.manageBackup));

  let fileInput: HTMLInputElement | undefined = $state();
  let selectedFile: File | null = $state(null);
  let restoring = $state(false);
  let parsedPayload: unknown = null;
  let preview = $state<BackupPreviewSummary | null>(null);
  let previewError = $state('');

  let schedule = $state<BackupScheduleSettings | null>(null);
  let cronValid = $state<boolean | null>(null);
  let savingSchedule = $state(false);
  let history = $state<BackupHistoryEntry[]>([]);
  let loadingHistory = $state(true);
  let creatingSnapshot = $state(false);
  let deletingId = $state<string | null>(null);

  onMount(() => {
    void fetchBackupSchedule().then((s) => (schedule = s));
    void loadHistory();
  });

  async function loadHistory(): Promise<void> {
    loadingHistory = true;
    try {
      history = await fetchBackupHistory();
    } finally {
      loadingHistory = false;
    }
  }

  const checkCron = debounce(async (expr: string) => {
    if (!expr) {
      cronValid = null;
      return;
    }
    const { valid } = await validateCron(expr);
    cronValid = valid;
  }, 400);

  $effect(() => {
    if (schedule) checkCron(schedule.cron);
  });

  async function saveSchedule(patch: Partial<BackupScheduleSettings>): Promise<void> {
    if (!schedule) return;
    if (patch.cron !== undefined && cronValid === false) {
      return;
    }
    savingSchedule = true;
    try {
      const { ok, data } = await updateBackupSchedule(patch);
      if (ok) schedule = data;
    } finally {
      savingSchedule = false;
    }
  }

  async function runBackupNow(): Promise<void> {
    creatingSnapshot = true;
    try {
      const { ok } = await createBackupSnapshot();
      if (ok) await loadHistory();
    } finally {
      creatingSnapshot = false;
    }
  }

  async function removeSnapshot(entry: BackupHistoryEntry): Promise<void> {
    const confirmed = await confirmDialog(`Delete backup snapshot "${entry.filename}"? This can't be undone.`, {
      confirmLabel: 'Delete',
      variant: 'destructive',
    });
    if (!confirmed) return;
    deletingId = entry.id;
    try {
      const { ok } = await deleteBackupSnapshot(entry.id);
      if (ok) history = history.filter((h) => h.id !== entry.id);
    } finally {
      deletingId = null;
    }
  }

  async function onFileChange(): Promise<void> {
    selectedFile = fileInput?.files?.[0] ?? null;
    parsedPayload = null;
    preview = null;
    previewError = '';
    if (!selectedFile) return;

    const text = await selectedFile.text();
    try {
      parsedPayload = JSON.parse(text);
    } catch {
      previewError = 'That file is not valid JSON';
      return;
    }
    const { ok, data } = await previewBackup(parsedPayload);
    if (!ok) {
      previewError = (data as { error?: string }).error ?? "That file doesn't look like a valid dkrypt backup";
      return;
    }
    preview = data as BackupPreviewSummary;
  }

  async function restore(): Promise<void> {
    if (!selectedFile || !preview) return;
    const confirmed = await confirmDialog(`Restore "${selectedFile.name}"? This overwrites all current data - anything added since export is lost.`, {
      confirmLabel: 'Restore',
      variant: 'destructive',
    });
    if (!confirmed) return;

    restoring = true;
    try {
      const { ok } = await importBackup(parsedPayload);
      if (ok) {
        selectedFile = null;
        parsedPayload = null;
        preview = null;
        if (fileInput) fileInput.value = '';
      }
    } finally {
      restoring = false;
    }
  }
</script>

<div class="flex flex-col gap-4">
  {#if canManageBackup}
  <Card title="Export">
    <div class="mb-3 text-sm text-muted">
      Downloads member role assignments, API keys (metadata and hashes, not their plaintext), scheduler settings, job history,
      and audit log as one JSON file. Treat it like a set of password hashes - it's not directly usable by an
      attacker, but it's not something to post publicly either.
    </div>
    <a href={backupExportUrl()} download class={buttonVariants('default', 'default')}>
      <Download class="h-4 w-4" />
      Download backup
    </a>
  </Card>
  {/if}

  <Card title="Scheduled backups">
    <div class="mb-3 text-sm text-muted">Automatically write a snapshot to disk on a schedule, kept as history below.</div>
    {#if schedule}
      <div class="flex items-center justify-between gap-3 border-b border-border pb-3">
        <div class="text-[13px] text-text">Enable scheduled backups</div>
        <Switch checked={schedule.enabled} disabled={savingSchedule || !canManageBackup} onCheckedChange={(checked) => void saveSchedule({ enabled: checked })} />
      </div>
      <div class="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label for="backup-cron" class="mb-1 block text-xs text-muted">Cron schedule</label>
          <Input
            id="backup-cron"
            bind:value={schedule.cron}
            onblur={() => void saveSchedule({ cron: schedule?.cron })}
            disabled={savingSchedule || !canManageBackup}
          />
          {#if cronValid === false}
            <div class="mt-1 text-xs text-err">Not a valid cron expression</div>
          {/if}
        </div>
        <div>
          <label for="backup-retention" class="mb-1 block text-xs text-muted">Keep this many snapshots</label>
          <Input
            id="backup-retention"
            type="number"
            min="1"
            max="90"
            bind:value={schedule.retentionCount}
            onblur={() => void saveSchedule({ retentionCount: Number(schedule?.retentionCount) })}
            disabled={savingSchedule || !canManageBackup}
          />
        </div>
      </div>
    {/if}
  </Card>

  {#if canManageBackup}
  <Card title="Restore">
    <div class="mb-3 flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn">
      <TriangleAlert class="mt-0.5 h-4 w-4 shrink-0" />
      <div>Restoring replaces everything above with what's in the file. There's no undo besides restoring a newer backup.</div>
    </div>
    <input bind:this={fileInput} onchange={onFileChange} type="file" accept="application/json" class="hidden" id="backup-file" />
    <div class="flex flex-wrap items-center gap-2.5">
      <label for="backup-file" class={buttonVariants('secondary', 'default')}>
        <Upload class="h-4 w-4" />
        Choose file
      </label>
      {#if selectedFile}
        <span class="text-sm text-muted">{selectedFile.name}</span>
      {/if}
    </div>
    {#if previewError}
      <div class="mt-3 text-sm text-err">{previewError}</div>
    {:else if preview}
      <div class="border-border bg-panel-muted mt-3 rounded-md border p-3 text-[13px]">
        {#if preview.exportedAt}
          <div class="mb-1.5 text-muted">Exported {fmtTime(preview.exportedAt)}</div>
        {/if}
        <div class="flex flex-wrap gap-x-4 gap-y-1">
          <span>Users {preview.current.users} → {preview.incoming.users}</span>
          <span>Roles {preview.current.roles} → {preview.incoming.roles}</span>
          <span>API keys {preview.current.apiKeys} → {preview.incoming.apiKeys}</span>
          <span>Watches {preview.current.watches} → {preview.incoming.watches}</span>
          <span>Devices {preview.current.devices} → {preview.incoming.devices}</span>
          <span>Job history {preview.current.jobHistory} → {preview.incoming.jobHistory}</span>
          <span>Audit log {preview.current.auditLog} → {preview.incoming.auditLog}</span>
        </div>
      </div>
    {/if}
    <Button class="mt-3" variant="destructive" disabled={!selectedFile || !preview} loading={restoring} onclick={restore}>Restore from backup</Button>
  </Card>
  {/if}

  <Card title="Backup history">
    {#snippet headerExtra()}
      {#if canManageBackup}<Button size="sm" variant="secondary" loading={creatingSnapshot} onclick={runBackupNow}>
        <RefreshCw class="h-4 w-4" />
        Back up now
      </Button>{/if}
    {/snippet}
    {#if loadingHistory}
      <div class="py-6 text-center text-sm text-muted">Loading...</div>
    {:else if history.length === 0}
      <EmptyState icon={Download} message="No backup snapshots yet - scheduled runs and manual backups will show up here." />
    {:else}
      <div class="divide-y divide-border border-y border-border">
        {#each history as entry (entry.id)}
          <div class="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
            <div class="min-w-0">
              <div class="text-text">{fmtTime(entry.createdAt)} <span class="text-muted">({fmtRelative(entry.createdAt)})</span></div>
              <div class="text-xs text-muted">{fmtSize(entry.sizeBytes)} · {entry.trigger === 'scheduled' ? 'Scheduled' : 'Manual'}</div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <a href={backupSnapshotDownloadUrl(entry.id)} download class={buttonVariants('secondary', 'sm')}>
                <Download class="h-3.5 w-3.5" />
                Download
              </a>
              {#if canManageBackup}
                <Button size="sm" variant="destructive" loading={deletingId === entry.id} onclick={() => removeSnapshot(entry)}>
                  <Trash2 class="h-3.5 w-3.5" />
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </Card>
</div>
