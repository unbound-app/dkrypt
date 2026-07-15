<script lang="ts">
  import { fetchSettings, saveSettings, testWebhook, validateCron, type SchedulerSettings } from '../../lib/api';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { debounce } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { confirmDialog, showToast } from '../../lib/ui.svelte';

  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

  let form = $state<SchedulerSettings>({
    watchBundleId: '',
    watchAppRepo: '',
    ghDispatchRepo: '',
    ghWorkflowFile: '',
    pollCron: '',
    notifyWebhookUrl: '',
  });
  let cronValid = $state<boolean | null>(null);
  let testingWebhook = $state(false);

  $effect(() => {
    void fetchSettings().then((s) => {
      form = { ...s };
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
  });

  function wouldDisableScheduler(): boolean {
    if (!liveState.overview?.schedulerEnabled) return false;
    return form.watchBundleId === '' || form.watchAppRepo === '' || form.ghDispatchRepo === '';
  }

  async function save(): Promise<void> {
    if (cronValid === false) {
      showToast('Poll cron is not a valid cron expression', 'error');
      return;
    }
    if (repoErrors.watchAppRepo || repoErrors.ghDispatchRepo) {
      showToast('Fix the repo fields before saving', 'error');
      return;
    }
    if (wouldDisableScheduler()) {
      if (!(await confirmDialog('This will disable the scheduler (a required field is empty). Save anyway?'))) return;
    }
    const { ok, data } = await saveSettings(form);
    if (ok) form = { ...data };
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
</script>

<Card title="Automated watch → GitHub dispatch">
  <label for="s-watchBundleId" class="mb-1 block text-xs text-muted">Watch bundle ID</label>
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

  <label for="s-pollCron" class="mt-3 mb-1 block text-xs text-muted">Poll cron</label>
  <Input id="s-pollCron" bind:value={form.pollCron} />
  {#if cronValid === false}
    <div class="mt-1 text-xs text-err">Not a valid cron expression</div>
  {/if}

  <label for="s-notifyWebhookUrl" class="mt-3 mb-1 block text-xs text-muted">Notification webhook URL (Discord-compatible, optional)</label>
  <div class="flex gap-2">
    <Input id="s-notifyWebhookUrl" bind:value={form.notifyWebhookUrl} />
    <Button variant="secondary" size="sm" disabled={testingWebhook} onclick={runTestWebhook}>Test</Button>
  </div>

  <Button class="mt-4" onclick={save}>Save</Button>
</Card>
