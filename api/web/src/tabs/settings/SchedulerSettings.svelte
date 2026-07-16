<script lang="ts">
  import { fetchSettings, previewDispatch, saveSettings, testWebhook, triggerDispatch, validateCron, type SchedulerSettings, type UpdateCheck } from '../../lib/api';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { debounce } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { confirmDialog, showToast } from '../../lib/ui.svelte';

  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const WEBHOOK_URL_RE = /^https?:\/\/.+/;

  let form = $state<SchedulerSettings>({
    watchBundleId: '',
    watchAppRepo: '',
    ghDispatchRepo: '',
    ghWorkflowFile: '',
    pollCron: '',
    notifyWebhookUrl: '',
  });
  let savedForm = $state<SchedulerSettings>({
    watchBundleId: '',
    watchAppRepo: '',
    ghDispatchRepo: '',
    ghWorkflowFile: '',
    pollCron: '',
    notifyWebhookUrl: '',
  });
  let cronValid = $state<boolean | null>(null);
  let testingWebhook = $state(false);
  let previewResult = $state<UpdateCheck | null>(null);
  let previewing = $state(false);
  let triggering = $state(false);
  let saving = $state(false);

  $effect(() => {
    void fetchSettings().then((s) => {
      form = { ...s };
      savedForm = { ...s };
    });
  });

  const checkCron = debounce(async (expr: string) => {
    if (!expr) {
      cronValid = null;
      return;
    }
    const { valid } = await validateCron(expr);
    cronValid = valid;
  }, 400);

  $effect(() => {
    checkCron(form.pollCron);
  });

  const repoErrors = $derived({
    watchAppRepo: form.watchAppRepo && !REPO_RE.test(form.watchAppRepo) ? 'Expected owner/repo' : '',
    ghDispatchRepo: form.ghDispatchRepo && !REPO_RE.test(form.ghDispatchRepo) ? 'Expected owner/repo' : '',
    notifyWebhookUrl: form.notifyWebhookUrl && !WEBHOOK_URL_RE.test(form.notifyWebhookUrl) ? 'Expected a full http(s):// URL' : '',
  });

  const hasUnsavedChanges = $derived(JSON.stringify(form) !== JSON.stringify(savedForm));

  function wouldDisableScheduler(): boolean {
    if (!liveState.overview?.schedulerEnabled) return false;
    return form.watchBundleId === '' || form.watchAppRepo === '' || form.ghDispatchRepo === '';
  }

  async function save(): Promise<void> {
    if (cronValid === false) {
      showToast('Poll cron is not a valid cron expression', 'error');
      return;
    }
    if (repoErrors.watchAppRepo || repoErrors.ghDispatchRepo || repoErrors.notifyWebhookUrl) {
      showToast('Fix the invalid fields before saving', 'error');
      return;
    }
    if (wouldDisableScheduler()) {
      if (!(await confirmDialog('This will disable the scheduler (a required field is empty). Save anyway?'))) return;
    }
    saving = true;
    try {
      const { ok, data } = await saveSettings(form);
      if (ok) {
        form = { ...data };
        savedForm = { ...data };
      }
    } finally {
      saving = false;
    }
  }

  async function runTestWebhook(): Promise<void> {
    testingWebhook = true;
    try {
      const { data } = await testWebhook();
      showToast(data.ok ? 'Test notification sent' : (data.error ?? 'Failed to send'), data.ok ? 'success' : 'error');
    } finally {
      testingWebhook = false;
    }
  }

  async function runPreview(): Promise<void> {
    previewing = true;
    previewResult = null;
    try {
      previewResult = await previewDispatch();
    } finally {
      previewing = false;
    }
  }

  async function runTrigger(): Promise<void> {
    if (!(await confirmDialog('This runs the same check the scheduler would on its own cron tick, right now - if there\'s a new version, it decrypts and dispatches for real. Continue?'))) return;
    triggering = true;
    try {
      const { ok, data } = await triggerDispatch();
      if (ok) showToast('Dispatch check triggered - watch Active Jobs / Logs for progress', 'success');
      else showToast(data.error ?? 'Failed to trigger', 'error');
    } finally {
      triggering = false;
    }
  }
</script>

<Card title="Automated watch → GitHub dispatch">
  <label for="s-watchBundleId" class="mb-1 block text-xs text-muted">Watch bundle ID (also drives the TestFlight watch, resolved automatically)</label>
  <Input id="s-watchBundleId" bind:value={form.watchBundleId} />

  <label for="s-watchAppRepo" class="mt-3 mb-1 block text-xs text-muted">Watch app repo (releases tracked here)</label>
  <Input id="s-watchAppRepo" bind:value={form.watchAppRepo} />
  {#if repoErrors.watchAppRepo}
    <div class="mt-1 text-xs text-err">{repoErrors.watchAppRepo}</div>
  {/if}

  <label for="s-ghDispatchRepo" class="mt-3 mb-1 block text-xs text-muted">GitHub dispatch repo (owns the workflow)</label>
  <Input id="s-ghDispatchRepo" bind:value={form.ghDispatchRepo} />
  {#if repoErrors.ghDispatchRepo}
    <div class="mt-1 text-xs text-err">{repoErrors.ghDispatchRepo}</div>
  {/if}

  <label for="s-ghWorkflowFile" class="mt-3 mb-1 block text-xs text-muted">Workflow file</label>
  <Input id="s-ghWorkflowFile" bind:value={form.ghWorkflowFile} />

  <div class="mt-3 mb-1 flex items-baseline justify-between">
    <label for="s-pollCron" class="block text-xs text-muted">Poll cron</label>
    <span class="text-xs text-muted">
      {#if liveState.overview?.lastSchedulerRunAt}
        last ran <RelativeTime ms={liveState.overview.lastSchedulerRunAt} />
      {:else}
        never ran yet
      {/if}
    </span>
  </div>
  <Input id="s-pollCron" bind:value={form.pollCron} />
  {#if cronValid === false}
    <div class="mt-1 text-xs text-err">Not a valid cron expression</div>
  {/if}

  <label for="s-notifyWebhookUrl" class="mt-3 mb-1 block text-xs text-muted">Notification webhook URL (Discord-compatible, optional)</label>
  <div class="flex gap-2">
    <Input id="s-notifyWebhookUrl" bind:value={form.notifyWebhookUrl} />
    <Button variant="secondary" loading={testingWebhook} onclick={runTestWebhook}>Test</Button>
  </div>
  {#if repoErrors.notifyWebhookUrl}
    <div class="mt-1 text-xs text-err">{repoErrors.notifyWebhookUrl}</div>
  {/if}

  <div class="mt-4 flex flex-wrap items-center gap-2">
    <Button loading={saving} onclick={save}>Save</Button>
    {#if hasUnsavedChanges}
      <span class="text-xs text-warn">Unsaved changes</span>
    {/if}
    <Button variant="secondary" loading={previewing} onclick={runPreview}>{previewing ? 'Checking…' : 'Preview next dispatch'}</Button>
    <Button variant="secondary" loading={triggering} onclick={runTrigger}>{triggering ? 'Triggering…' : 'Trigger dispatch now'}</Button>
  </div>

  {#if previewResult}
    <div class="border-border bg-panel-muted mt-3 rounded-md border p-3 text-sm">
      <div class={previewResult.wouldDispatch ? 'text-ok' : 'text-muted'}>{previewResult.reason}</div>
      {#if previewResult.itunesVersion}
        <div class="mt-1 text-xs text-muted">iTunes version: {previewResult.itunesVersion}</div>
      {/if}
      {#if previewResult.testflight}
        <div class="border-border mt-2 border-t pt-2">
          <div class={previewResult.testflight.wouldDispatch ? 'text-ok' : 'text-muted'}>{previewResult.testflight.reason}</div>
          {#if previewResult.testflight.latestTag}
            <div class="mt-1 text-xs text-muted">Latest TestFlight tag: {previewResult.testflight.latestTag}</div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</Card>
