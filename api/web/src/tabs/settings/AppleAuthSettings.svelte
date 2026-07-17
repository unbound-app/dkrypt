<script lang="ts">
  import { cancelAppleAuth, fetchAppleAuthStatus, startAppleAuth, submitAppleInput, type AppleAuthStatus } from '../../lib/api';
  import CopyButton from '../../components/CopyButton.svelte';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { liveState } from '../../lib/live.svelte';
  import { cn } from '../../lib/utils';

  type Step = 'idle' | 'connecting' | 'signing-in' | '2fa' | 'done' | 'failed';

  const STEPS: { id: Step; label: string }[] = [
    { id: 'connecting', label: 'Connecting' },
    { id: 'signing-in', label: 'Signing in' },
    { id: '2fa', label: '2FA' },
    { id: 'done', label: 'Done' },
  ];

  let fallbackStatus = $state<AppleAuthStatus | null>(null);
  let inputValue = $state('');
  let inputEl: HTMLInputElement | undefined = $state();
  let outputEl: HTMLPreElement | undefined = $state();
  let outputOpen = $state(false);
  let starting = $state(false);
  let cancelling = $state(false);
  let submitting = $state(false);

  const status = $derived(liveState.appleAuthStatus ?? fallbackStatus);

  $effect(() => {
    if (!liveState.appleAuthStatus) void fetchAppleAuthStatus().then((s) => (fallbackStatus = s));
  });

  $effect(() => {
    if (status?.waitingForInput) inputEl?.focus();
  });

  $effect(() => {
    void status?.log;
    if (outputOpen && outputEl) outputEl.scrollTop = outputEl.scrollHeight;
  });

  async function start(): Promise<void> {
    starting = true;
    try {
      await startAppleAuth();
    } finally {
      starting = false;
    }
  }

  async function cancel(): Promise<void> {
    cancelling = true;
    try {
      await cancelAppleAuth();
    } finally {
      cancelling = false;
    }
  }

  async function submit(): Promise<void> {
    const value = inputValue;
    inputValue = '';
    submitting = true;
    try {
      await submitAppleInput(value);
    } finally {
      submitting = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') void submit();
  }

  const step = $derived.by((): Step => {
    if (!status || (!status.running && !status.log)) return 'idle';
    if (!status.running && status.success === true) return 'done';
    if (!status.running && status.success === false) return 'failed';
    const log = status.log.toLowerCase();
    if (/2fa|two-factor|verification code/.test(log)) return '2fa';
    if (/sign.?in|logging in|authenticat/.test(log)) return 'signing-in';
    return 'connecting';
  });

  const stepIndex = $derived(STEPS.findIndex((s) => s.id === step));
</script>

<Card title="Apple ID re-authentication">
  <div class="mb-2.5 text-sm text-muted">Only re-does App Store sign-in, not the device connection.</div>

  {#if step !== 'idle'}
    <div class="mb-4 flex gap-1.5">
      {#each STEPS as s, i (s.id)}
        {@const isDone = i < stepIndex || step === 'done'}
        {@const isActive = i === stepIndex}
        {@const isFailed = step === 'failed' && isActive}
        <div class="flex flex-1 flex-col items-center gap-1.5 text-[11px] text-muted" class:text-text={isActive}>
          <div
            class={cn('h-1 w-full rounded-full bg-border', isDone && 'bg-ok', isActive && !isFailed && 'bg-accent', isFailed && 'bg-err')}
          ></div>
          <span>{s.label}</span>
        </div>
      {/each}
    </div>
  {/if}

  <div class="flex gap-2">
    <Button disabled={status?.running} loading={starting} onclick={start}>Start re-authentication</Button>
    <Button variant="secondary" disabled={!status?.running} loading={cancelling} onclick={cancel}>Cancel</Button>
  </div>

  <details class="mt-3.5" bind:open={outputOpen}>
    <summary class="cursor-pointer text-sm text-muted">Raw output</summary>
    <div class="mt-2 flex justify-end">
      <CopyButton text={status?.log || ''} label="Copy" />
    </div>
    <pre
      bind:this={outputEl}
      class="border-border bg-panel-muted mt-2 max-h-64 overflow-y-auto rounded-md border p-2.5 text-xs break-all whitespace-pre-wrap">{status?.log ||
        '(not started)'}</pre>
  </details>

  {#if status?.waitingForInput}
    <div class="mt-2.5 flex gap-2">
      <Input bind:ref={inputEl} bind:value={inputValue} onkeydown={onKeydown} placeholder="type the requested value and press Enter" />
      <Button size="sm" loading={submitting} onclick={submit}>Send</Button>
    </div>
  {/if}
</Card>
