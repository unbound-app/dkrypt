<script lang="ts">
  import { Moon, Sun } from 'lucide-svelte';
  import { Toaster } from 'svelte-sonner';
  import AlertBanner from './components/AlertBanner.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ConfirmModal from './components/ConfirmModal.svelte';
  import Login from './components/Login.svelte';
  import SessionExpiryBanner from './components/SessionExpiryBanner.svelte';
  import Button from './lib/components/ui/Button.svelte';
  import Tabs from './lib/components/ui/Tabs.svelte';
  import { connectLive, disconnectLive, liveState } from './lib/live.svelte';
  import { logout, refreshSession, sessionState } from './lib/session.svelte';
  import { initTheme, openPalette, setActiveTab, setTheme, tabState, themeState, type TabId } from './lib/ui.svelte';
  import Docs from './tabs/Docs.svelte';
  import Home from './tabs/Home.svelte';
  import Keys from './tabs/Keys.svelte';
  import Logs from './tabs/Logs.svelte';
  import Settings from './tabs/Settings.svelte';

  initTheme();

  let homeRef: Home | undefined = $state();

  const TABS: { id: TabId; label: string; adminOnly?: boolean }[] = [
    { id: 'home', label: 'Home' },
    { id: 'keys', label: 'API Keys' },
    { id: 'logs', label: 'Logs' },
    { id: 'docs', label: 'Docs' },
    { id: 'settings', label: 'Settings', adminOnly: true },
  ];

  const visibleTabs = $derived(TABS.filter((t) => !t.adminOnly || sessionState.role === 'admin'));

  $effect(() => {
    void refreshSession();
  });

  $effect(() => {
    if (sessionState.loggedIn) connectLive();
    else disconnectLive();
  });

  $effect(() => {
    if (sessionState.loggedIn && !visibleTabs.some((t) => t.id === tabState.active)) setActiveTab('home');
  });

  function onKeydown(e: KeyboardEvent): void {
    const typingInField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName ?? '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === '/' && !typingInField && tabState.active === 'home') {
      e.preventDefault();
      homeRef?.focusSearch();
    }
  }

  function toggleTheme(): void {
    setTheme(themeState.value === 'light' ? 'dark' : 'light');
  }
</script>

<svelte:window onkeydown={onKeydown} />

<Toaster theme={themeState.value ?? 'dark'} richColors position="bottom-right" />

{#if !sessionState.loggedIn}
  <Login />
{:else}
  <div class="min-h-screen">
    <header class="border-border flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
      <div class="flex items-center gap-3">
        <h1 class="text-[15px] font-semibold">ipadecrypt-service</h1>
        {#if liveState.overview}
          <span class="border-border inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium text-muted">
            <span class={['h-1.5 w-1.5 rounded-full', liveState.overview.schedulerEnabled ? 'bg-ok' : 'bg-muted']}></span>
            Scheduler {liveState.overview.schedulerEnabled ? 'on' : 'off'}
          </span>
        {/if}
      </div>
      <div class="flex items-center gap-2.5">
        <Button variant="secondary" size="icon" onclick={toggleTheme} aria-label="Toggle theme" title="Toggle theme">
          {#if themeState.value === 'light'}
            <Moon class="h-4 w-4" />
          {:else}
            <Sun class="h-4 w-4" />
          {/if}
        </Button>
        <span class="max-w-[40vw] truncate text-[13px] text-muted sm:max-w-[55vw]">{sessionState.sub} ({sessionState.role})</span>
        <Button variant="secondary" size="sm" onclick={() => void logout()}>Log out</Button>
      </div>
    </header>
    <main class="mx-auto max-w-[1120px] p-6">
      <SessionExpiryBanner />
      <AlertBanner />
      <Tabs items={visibleTabs.map((t) => ({ id: t.id, label: t.label }))} value={tabState.active} onValueChange={(v) => setActiveTab(v as TabId)} class="mb-5" />

      <div class:hidden={tabState.active !== 'home'}>
        <Home bind:this={homeRef} />
      </div>
      <div class:hidden={tabState.active !== 'keys'}>
        <Keys />
      </div>
      <div class:hidden={tabState.active !== 'logs'}>
        <Logs />
      </div>
      <div class:hidden={tabState.active !== 'docs'}>
        <Docs />
      </div>
      {#if sessionState.role === 'admin'}
        <div class:hidden={tabState.active !== 'settings'}>
          <Settings />
        </div>
      {/if}
    </main>
  </div>
{/if}

<ConfirmModal />
<CommandPalette />
