<script lang="ts">
  import { ShieldCheck } from 'lucide-svelte';
  import Button from '#lib/components/ui/Button.svelte';
  import Card from '#lib/components/ui/Card.svelte';
  import Input from '#lib/components/ui/Input.svelte';
  import Label from '#lib/components/ui/Label.svelte';
  import { refreshSession } from '#lib/session.svelte';
  import { showToast } from '#lib/ui.svelte';

  let token = $state('');
  let submitting = $state(false);
  let error = $state('');

  async function submit(): Promise<void> {
    if (!token.trim()) return;
    submitting = true;
    error = '';
    try {
      const response = await fetch('/v1/auth/mfa/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        error = body.error ?? 'That code could not be verified.';
        return;
      }
      await refreshSession();
      showToast('Verification complete.', 'success');
    } finally {
      submitting = false;
    }
  }
</script>

<div class="flex min-h-screen items-center justify-center bg-background p-6">
  <Card class="w-full max-w-sm p-7 text-center">
    <div class="bg-accent/15 text-accent mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl"><ShieldCheck class="size-6" aria-hidden="true" /></div>
    <h1 class="text-lg font-semibold">Verify your sign-in</h1>
    <p class="mt-2 text-sm text-muted">Enter the code from your authenticator app or use one of your recovery codes.</p>
    <Label for="mfa-verify-token" class="mt-5 mb-1 block text-left text-xs text-muted">Verification code</Label>
    <Input id="mfa-verify-token" autocomplete="one-time-code" inputmode="numeric" bind:value={token} onkeydown={(event) => event.key === 'Enter' && void submit()} />
    {#if error}<p class="mt-2 text-left text-xs text-err" role="alert">{error}</p>{/if}
    <Button class="mt-4 w-full" loading={submitting} disabled={!token.trim()} onclick={() => void submit()}>Continue</Button>
  </Card>
</div>
