<script lang="ts">
  import { cancelAppleAuth, fetchAppleAuthStatus, startAppleAuth, submitAppleInput, type AppleAuthStatus } from '../../lib/api';
  import Button from '../../lib/components/ui/Button.svelte';
  import Card from '../../lib/components/ui/Card.svelte';
  import Input from '../../lib/components/ui/Input.svelte';
  import { cn } from '../../lib/utils';

  type Step = 'idle' | 'connecting' | 'signing-in' | '2fa' | 'done' | 'failed';

  const STEPS: { id: Step; label: string }[] = [
    { id: 'connecting', label: 'Connecting' },
    { id: 'signing-in', label: 'Signing in' },
    { id: '2fa', label: '2FA' },
    { id: 'done', label: 'Done' },
  ];

  let status = $state<AppleAuthStatus | null>(null);
  let inputValue = $state('');
  let inputEl: HTMLInputElement | undefined = $state();
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  async function refresh(): Promise<void> {
    status = await fetchAppleAuthStatus();
  }

  $effect(() => {
    void refresh();
    pollTimer = setInterval(() => void refresh(), 1200);
    return () => clearInterval(pollTimer);
  });

  $effect(() => {
    if (status?.waitingForInput) inputEl?.focus();
  });

  async function start(): Promise<void> {
    const { ok } = await startAppleAuth();
    if (ok) void refresh();
  }

  async function cancel(): Promise<void> {
    await cancelAppleAuth();
    void refresh();
  }

  async function submit(): Promise<void> {
    const value = inputValue;
    inputValue = '';
    await submitAppleInput(value);
    void refresh();
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
  <div class="mb-2.5 text-sm text-muted">Redoes the App Store sign-in only - the device connection isn't touched.</div>

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
    <Button disabled={status?.running} onclick={start}>Start re-authentication</Button>
    <Button variant="secondary" disabled={!status?.running} onclick={cancel}>Cancel</Button>
  </div>

  <details class="mt-3.5">
    <summary class="cursor-pointer text-sm text-muted">Raw output</summary>
    <pre class="border-border bg-panel-muted mt-2 max-h-64 overflow-y-auto rounded-md border p-2.5 text-xs break-all whitespace-pre-wrap">{status?.log ||
        '(not started)'}</pre>
  </details>

  {#if status?.waitingForInput}
    <div class="mt-2.5 flex gap-2">
      <Input bind:ref={inputEl} bind:value={inputValue} onkeydown={onKeydown} placeholder="type the requested value and press Enter" />
      <Button size="sm" onclick={submit}>Send</Button>
    </div>
  {/if}
</Card>
