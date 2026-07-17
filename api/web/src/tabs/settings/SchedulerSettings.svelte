<script lang="ts">
  import { fetchSettings, previewDispatch, saveSettings, testWebhook, triggerDispatch, validateCron, type SchedulerSettings, type UpdateCheck } from '../../lib/api';
  import RelativeTime from '../../components/RelativeTime.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import Select from '../../lib/components/ui/Select.svelte';
  import Switch from '../../lib/components/ui/Switch.svelte';
  import { debounce } from '../../lib/format';
  import { liveState } from '../../lib/live.svelte';
  import { sessionState } from '../../lib/session.svelte';
  import { confirmDialog, showToast } from '../../lib/ui.svelte';

  const FORMAT_OPTIONS = [
    { value: 'embed', label: 'Rich embed (Discord)' },
    { value: 'plain', label: 'Plain text (Slack / generic)' },
  ];

  const NOTIFY_EVENTS: { key: keyof SchedulerSettings; label: string; description: string }[] = [
    { key: 'notifyOnKeyRequest', label: 'API key requests', description: 'A user without approveApiKeys requests a new key' },
    { key: 'notifyOnDispatchSuccess', label: 'Dispatch succeeded', description: 'The scheduler decrypted and dispatched a new version' },
    { key: 'notifyOnDispatchFailure', label: 'Dispatch failed', description: 'A scheduled decrypt, dispatch, or workflow-run poll failed' },
    { key: 'notifyOnAppleAuthAlert', label: 'App Store auth issues', description: 'A decrypt failed in a way that looks like an auth problem' },
    { key: 'notifyOnKeyExpiringSoon', label: 'API key expiring soon', description: 'An approved key has 7 days or less left before it expires' },
    { key: 'notifyOnDeviceOffline', label: 'iDevice unreachable', description: 'The iDevice stays unreachable past the alert threshold below' },
    { key: 'notifyOnDeviceBatteryHot', label: 'iDevice battery hot', description: 'Battery temperature reaches the alert threshold below' },
    { key: 'notifyOnDeviceBatteryLow', label: 'iDevice battery low', description: 'Battery drops to the alert threshold below while not charging' },
  ];

  const RETRY_OPTIONS = [
    { value: '0', label: 'Off (no retry)' },
    { value: '1', label: '1 retry' },
    { value: '2', label: '2 retries' },
    { value: '3', label: '3 retries' },
    { value: '5', label: '5 retries' },
  ];

  const OFFLINE_ALERT_OPTIONS = [
    { value: '5', label: '5 minutes' },
    { value: '15', label: '15 minutes' },
    { value: '30', label: '30 minutes' },
    { value: '60', label: '1 hour' },
    { value: '180', label: '3 hours' },
  ];

  const BATTERY_HOT_ALERT_OPTIONS = [
    { value: '40', label: '40°C' },
    { value: '42', label: '42°C' },
    { value: '45', label: '45°C' },
    { value: '48', label: '48°C' },
    { value: '50', label: '50°C' },
  ];

  const BATTERY_LOW_ALERT_OPTIONS = [
    { value: '5', label: '5%' },
    { value: '10', label: '10%' },
    { value: '15', label: '15%' },
    { value: '20', label: '20%' },
    { value: '30', label: '30%' },
  ];

  const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
  const WEBHOOK_URL_RE = /^https?:\/\/.+/;

  const canManageScheduler = $derived(!!sessionState.permissions?.manageScheduler);
  const canTriggerDispatch = $derived(!!sessionState.permissions?.triggerDispatch);

  const DEFAULT_FORM: SchedulerSettings = {
    watchBundleId: '',
    watchAppRepo: '',
    ghDispatchRepo: '',
    ghWorkflowFile: '',
    pollCron: '',
    notifyWebhookUrl: '',
    notifyFormat: 'embed',
    notifyOnKeyRequest: true,
    notifyOnDispatchSuccess: true,
    notifyOnDispatchFailure: true,
    notifyOnAppleAuthAlert: true,
    notifyOnKeyExpiringSoon: true,
    notifyOnDeviceOffline: true,
    notifyOnDeviceBatteryHot: true,
    notifyOnDeviceBatteryLow: true,
    schedulerRetryCount: 0,
    deviceOfflineAlertMinutes: 15,
    batteryHotAlertC: 45,
    batteryLowAlertPercent: 10,
  };

  let form = $state<SchedulerSettings>({ ...DEFAULT_FORM });
  let savedForm = $state<SchedulerSettings>({ ...DEFAULT_FORM });
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
      if (!(await confirmDialog('This will disable the scheduler (a required field is empty). Save anyway?', { variant: 'default', confirmLabel: 'Save anyway' })))
        return;
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
      const { data } = await testWebhook(form.notifyWebhookUrl || undefined);
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
    if (
      !(await confirmDialog(
        'This runs the same check the scheduler would on its own cron tick, right now - if there\'s a new version, it decrypts and dispatches for real. Continue?',
        { variant: 'default', confirmLabel: 'Trigger now' },
      ))
    )
      return;
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
  {#if !canManageScheduler}
    <div class="border-border bg-panel-muted mb-3.5 rounded-md border p-2.5 text-xs text-muted">
      You can operate the scheduler but not change its configuration - fields below are read-only.
    </div>
  {/if}

  <label for="s-watchBundleId" class="mb-1 block text-xs text-muted">Watch bundle ID (also drives the TestFlight watch, resolved automatically)</label>
  <Input id="s-watchBundleId" bind:value={form.watchBundleId} disabled={!canManageScheduler} />

  <label for="s-watchAppRepo" class="mt-3 mb-1 block text-xs text-muted">Watch app repo (releases tracked here)</label>
  <Input id="s-watchAppRepo" bind:value={form.watchAppRepo} disabled={!canManageScheduler} />
  {#if repoErrors.watchAppRepo}
    <div class="mt-1 text-xs text-err">{repoErrors.watchAppRepo}</div>
  {/if}

  <label for="s-ghDispatchRepo" class="mt-3 mb-1 block text-xs text-muted">GitHub dispatch repo (owns the workflow)</label>
  <Input id="s-ghDispatchRepo" bind:value={form.ghDispatchRepo} disabled={!canManageScheduler} />
  {#if repoErrors.ghDispatchRepo}
    <div class="mt-1 text-xs text-err">{repoErrors.ghDispatchRepo}</div>
  {/if}

  <label for="s-ghWorkflowFile" class="mt-3 mb-1 block text-xs text-muted">Workflow file</label>
  <Input id="s-ghWorkflowFile" bind:value={form.ghWorkflowFile} disabled={!canManageScheduler} />

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
  <Input id="s-pollCron" bind:value={form.pollCron} disabled={!canManageScheduler} />
  {#if cronValid === false}
    <div class="mt-1 text-xs text-err">Not a valid cron expression</div>
  {/if}

  <label for="s-retryCount" class="mt-3 mb-1 block text-xs text-muted">Retry a failed check before recording/notifying failure</label>
  <Select
    id="s-retryCount"
    items={RETRY_OPTIONS}
    value={String(form.schedulerRetryCount)}
    onValueChange={(v) => (form = { ...form, schedulerRetryCount: Number(v) })}
    disabled={!canManageScheduler}
    class="w-full"
  />
  <div class="mt-1 text-xs text-muted">Each retry waits longer than the last (30s, then 60s, then 120s, ...) before trying again.</div>

  <label for="s-notifyWebhookUrl" class="mt-3 mb-1 block text-xs text-muted">Notification webhook URL (Discord-compatible, optional)</label>
  <div class="flex gap-2">
    <Input id="s-notifyWebhookUrl" bind:value={form.notifyWebhookUrl} disabled={!canManageScheduler} />
    {#if canTriggerDispatch}
      <Button variant="secondary" loading={testingWebhook} onclick={runTestWebhook}>Test</Button>
    {/if}
  </div>
  <div class="mt-1 text-xs text-muted">Test sends to whatever's currently typed above, saved or not.</div>
  {#if repoErrors.notifyWebhookUrl}
    <div class="mt-1 text-xs text-err">{repoErrors.notifyWebhookUrl}</div>
  {/if}

  <label for="s-notifyFormat" class="mt-3 mb-1 block text-xs text-muted">Webhook format</label>
  <Select
    id="s-notifyFormat"
    items={FORMAT_OPTIONS}
    value={form.notifyFormat}
    onValueChange={(v) => (form = { ...form, notifyFormat: v as SchedulerSettings['notifyFormat'] })}
    disabled={!canManageScheduler}
    class="w-full"
  />

  <label for="s-offlineMinutes" class="mt-3 mb-1 block text-xs text-muted">iDevice offline alert threshold</label>
  <Select
    id="s-offlineMinutes"
    items={OFFLINE_ALERT_OPTIONS}
    value={String(form.deviceOfflineAlertMinutes)}
    onValueChange={(v) => (form = { ...form, deviceOfflineAlertMinutes: Number(v) })}
    disabled={!canManageScheduler}
    class="w-full"
  />

  <label for="s-batteryHot" class="mt-3 mb-1 block text-xs text-muted">Battery hot alert threshold</label>
  <Select
    id="s-batteryHot"
    items={BATTERY_HOT_ALERT_OPTIONS}
    value={String(form.batteryHotAlertC)}
    onValueChange={(v) => (form = { ...form, batteryHotAlertC: Number(v) })}
    disabled={!canManageScheduler}
    class="w-full"
  />

  <label for="s-batteryLow" class="mt-3 mb-1 block text-xs text-muted">Battery low alert threshold (while not charging)</label>
  <Select
    id="s-batteryLow"
    items={BATTERY_LOW_ALERT_OPTIONS}
    value={String(form.batteryLowAlertPercent)}
    onValueChange={(v) => (form = { ...form, batteryLowAlertPercent: Number(v) })}
    disabled={!canManageScheduler}
    class="w-full"
  />

  <div class="mt-3 mb-1 text-xs text-muted">Notify on</div>
  <div class="border-border divide-border divide-y rounded-lg border">
    {#each NOTIFY_EVENTS as event (event.key)}
      <div class="flex items-center gap-3 px-3 py-2">
        <div class="min-w-0 flex-1">
          <div class="text-[13px] text-text">{event.label}</div>
          <div class="text-[11px] text-muted">{event.description}</div>
        </div>
        <Switch
          checked={form[event.key] as boolean}
          disabled={!canManageScheduler}
          onCheckedChange={(checked) => (form = { ...form, [event.key]: checked })}
          aria-label={event.label}
        />
      </div>
    {/each}
  </div>

  <div class="mt-4 flex flex-wrap items-center gap-2">
    {#if canManageScheduler}
      <Button loading={saving} onclick={save}>Save</Button>
      {#if hasUnsavedChanges}
        <span class="text-xs text-warn">Unsaved changes</span>
      {/if}
    {/if}
    {#if canTriggerDispatch}
      <Button variant="secondary" loading={previewing} onclick={runPreview}>{previewing ? 'Checking…' : 'Preview next dispatch'}</Button>
      <Button variant="secondary" loading={triggering} onclick={runTrigger}>{triggering ? 'Triggering…' : 'Trigger dispatch now'}</Button>
    {/if}
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
