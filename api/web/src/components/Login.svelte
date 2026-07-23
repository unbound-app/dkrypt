<script lang="ts">
  import { ChevronDown, Eye, EyeOff, Lock } from 'lucide-svelte';
  import Button from '../lib/components/ui/Button.svelte';
  import Card from '../lib/components/ui/Card.svelte';
  import Input from '../lib/components/ui/Input.svelte';
  import { loginRoot, sessionState } from '../lib/session.svelte';
  import { cn } from '../lib/utils';

  let password = $state('');
  let loginError = $state('');
  let attemptsRemaining = $state<number | undefined>(undefined);
  let detailsOpen = $state(!sessionState.githubOauthEnabled && !sessionState.discordOauthEnabled);
  let oauthError = $state('');
  let submitting = $state(false);
  let showPassword = $state(false);
  let passwordEl: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (detailsOpen) passwordEl?.focus();
  });

  const OAUTH_ERROR_MESSAGES: Record<string, string | ((user: string | null) => string)> = {
    state_mismatch: 'Sign-in session expired - please try again.',
    disabled: "GitHub sign-in isn't configured.",
    failed: 'GitHub sign-in failed - check the server logs.',
    discord_disabled: "Discord sign-in isn't configured.",
    discord_failed: 'Discord sign-in failed - check the server logs.',
  };

  $effect(() => {
    const params = new URLSearchParams(location.search);
    const code = params.get('auth_error');
    if (!code) return;
    const message = OAUTH_ERROR_MESSAGES[code];
    oauthError = typeof message === 'function' ? message(params.get('user')) : (message ?? 'GitHub sign-in failed.');
    history.replaceState(null, '', location.pathname);
  });

  async function submit(): Promise<void> {
    submitting = true;
    try {
      const result = await loginRoot(password);
      if (!result.ok) {
        loginError = result.error ?? 'Wrong password.';
        attemptsRemaining = result.attemptsRemaining;
      } else {
        attemptsRemaining = undefined;
      }
    } finally {
      submitting = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') void submit();
  }
</script>

<div
  class="flex min-h-screen items-center justify-center p-6"
  style="background: radial-gradient(circle at 50% 15%, color-mix(in srgb, var(--color-panel) 60%, var(--color-bg)) 0%, var(--color-bg) 60%);"
>
  <Card class="w-full max-w-[380px] px-8 py-9 text-center shadow-2xl">
    <div class="bg-accent shadow-accent/35 mx-auto mb-5 flex h-[60px] w-[60px] items-center justify-center rounded-2xl shadow-xl">
      <Lock class="h-7 w-7 text-white" />
    </div>
    <h2 class="mb-1.5 text-[19px] font-semibold">dkrypt</h2>
    <div class="mb-6.5 text-[13px] text-muted">Sign in to manage decrypts, keys, and settings.</div>

    {#if sessionState.githubOauthEnabled}
      <a
        href="/v1/auth/github/login"
        class="flex w-full items-center justify-center gap-2.5 rounded-md bg-[#24292f] px-4 py-2.5 text-sm font-medium text-white no-underline hover:opacity-90"
      >
        <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path
            d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
          />
        </svg>
        Sign in with GitHub
      </a>
    {/if}
    {#if sessionState.discordOauthEnabled}
      <a
        href="/v1/auth/discord/login"
        class="mt-3 flex w-full items-center justify-center gap-2.5 rounded-md bg-[#5865f2] px-4 py-2.5 text-sm font-medium text-white no-underline hover:opacity-90"
      >
        <svg width="19" height="15" viewBox="0 0 127.14 96.36" fill="currentColor" aria-hidden="true">
          <path d="M107.7 8.07A105.2 105.2 0 0 0 81.47 0a72.1 72.1 0 0 0-3.36 6.83 97.7 97.7 0 0 0-29.11 0A72.4 72.4 0 0 0 45.64 0 105.9 105.9 0 0 0 19.4 8.09C2.79 32.65-1.71 56.6.54 80.21a105.7 105.7 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.4 68.4 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.6 75.6 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.7 68.7 0 0 1-10.87 5.19 77.1 77.1 0 0 0 6.89 11.1 105.3 105.3 0 0 0 32.17-16.15c2.64-27.38-4.51-51.11-18.88-72.14ZM42.45 65.69C32.82 65.69 24.89 56.8 24.89 45.9s7.75-19.79 17.56-19.79S60.18 35.08 60 45.9c0 10.9-7.75 19.79-17.55 19.79Zm42.24 0c-9.63 0-17.55-8.89-17.55-19.79s7.74-19.79 17.55-19.79 17.72 8.97 17.55 19.79c0 10.9-7.74 19.79-17.55 19.79Z" />
        </svg>
        Sign in with Discord
      </a>
    {/if}
    {#if oauthError}
      <div class="mt-3.5 text-[12.5px] text-err">{oauthError}</div>
    {/if}

    <details bind:open={detailsOpen} class="group mt-4.5 text-left">
      <summary
        class={cn(
          'flex cursor-pointer list-none items-center justify-center gap-1 pt-2.5 text-center text-[12.5px] text-muted select-none hover:text-text',
          !sessionState.githubOauthEnabled && !sessionState.discordOauthEnabled && 'hidden',
        )}
      >
        Sign in with root password
        <ChevronDown class="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
      </summary>
      <div class="pt-1.5" class:mt-1.5={detailsOpen}>
        <label for="password" class="mb-1 block text-xs text-muted">Root password</label>
        <div class="relative">
          <Input
            bind:ref={passwordEl}
            type={showPassword ? 'text' : 'password'}
            id="password"
            autocomplete="current-password"
            bind:value={password}
            onkeydown={onKeydown}
            class="pr-9"
          />
          <button
            type="button"
            class="text-muted hover:text-text absolute top-1/2 right-2.5 -translate-y-1/2 cursor-pointer"
            onclick={() => (showPassword = !showPassword)}
            aria-label={showPassword ? 'Hide password' : 'Show password'}
            title={showPassword ? 'Hide password' : 'Show password'}
          >
            {#if showPassword}
              <EyeOff class="h-3.5 w-3.5" />
            {:else}
              <Eye class="h-3.5 w-3.5" />
            {/if}
          </button>
        </div>
        <Button variant="secondary" class="mt-3.5 w-full" loading={submitting} onclick={submit}>Sign in</Button>
        {#if loginError}
          <div class="mt-2 text-[13px] text-muted">
            {loginError}
            {#if attemptsRemaining !== undefined && attemptsRemaining > 0}
              ({attemptsRemaining} attempt{attemptsRemaining === 1 ? '' : 's'} left before a temporary lockout)
            {/if}
          </div>
        {/if}
      </div>
    </details>
  </Card>
</div>
