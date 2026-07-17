<script lang="ts">
  import { Download, TriangleAlert, Upload } from 'lucide-svelte';
  import { backupExportUrl, importBackup } from '../../lib/api';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import { buttonVariants } from '../../lib/components/ui/variants';
  import { fmtTime } from '../../lib/format';
  import { confirmDialog } from '../../lib/ui.svelte';

  interface BackupPreview {
    exportedAt?: number;
    users: number;
    apiKeys: number;
    jobHistory: number;
    auditLog: number;
  }

  let fileInput: HTMLInputElement | undefined = $state();
  let selectedFile: File | null = $state(null);
  let restoring = $state(false);
  let parsedPayload: unknown = null;
  let preview = $state<BackupPreview | null>(null);
  let previewError = $state('');

  function summarize(payload: unknown): BackupPreview | null {
    if (typeof payload !== 'object' || payload === null) return null;
    const b = payload as Record<string, unknown>;
    return {
      exportedAt: typeof b.exportedAt === 'number' ? b.exportedAt : undefined,
      users: Array.isArray(b.allowedUsers) ? b.allowedUsers.length : 0,
      apiKeys: Array.isArray(b.apiKeys) ? b.apiKeys.length : 0,
      jobHistory: Array.isArray(b.jobHistory) ? b.jobHistory.length : 0,
      auditLog: Array.isArray(b.auditLog) ? b.auditLog.length : 0,
    };
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
    preview = summarize(parsedPayload);
    if (!preview) previewError = "That file doesn't look like a dkrypt backup";
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
  <Card title="Export">
    <div class="mb-3 text-sm text-muted">
      Downloads the allowlist, API keys (metadata and hashes, not their plaintext), scheduler settings, job history,
      and audit log as one JSON file. Treat it like a set of password hashes - it's not directly usable by an
      attacker, but it's not something to post publicly either.
    </div>
    <a href={backupExportUrl()} download class={buttonVariants('default', 'default')}>
      <Download class="h-4 w-4" />
      Download backup
    </a>
  </Card>

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
          <span>{preview.users} user{preview.users === 1 ? '' : 's'}</span>
          <span>{preview.apiKeys} API key{preview.apiKeys === 1 ? '' : 's'}</span>
          <span>{preview.jobHistory} job history entr{preview.jobHistory === 1 ? 'y' : 'ies'}</span>
          <span>{preview.auditLog} audit log entr{preview.auditLog === 1 ? 'y' : 'ies'}</span>
        </div>
      </div>
    {/if}
    <Button class="mt-3" variant="destructive" disabled={!selectedFile || !preview} loading={restoring} onclick={restore}>Restore from backup</Button>
  </Card>
</div>
