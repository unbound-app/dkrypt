<script lang="ts">
  import { Moon, Monitor, Rows2, Rows3, Sun } from 'lucide-svelte';
  import { Toaster } from 'svelte-sonner';
  import AlertBanner from './components/AlertBanner.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import ConfirmModal from './components/ConfirmModal.svelte';
  import ConnectionBanner from './components/ConnectionBanner.svelte';
  import Login from './components/Login.svelte';
  import NotificationBell from './components/NotificationBell.svelte';
  import SessionExpiryBanner from './components/SessionExpiryBanner.svelte';
  import SetupBanner from './components/SetupBanner.svelte';
  import ShortcutsHelp from './components/ShortcutsHelp.svelte';
  import Badge from './lib/components/ui/Badge.svelte';
  import Button from './lib/components/ui/Button.svelte';
  import Dialog from './lib/components/ui/Dialog.svelte';
  import Tabs from './lib/components/ui/Tabs.svelte';
  import { buttonVariants } from './lib/components/ui/variants';
  import { KOFI_URL, REPO_URL } from './lib/constants';
  import { myDecryptsState } from './lib/decrypts.svelte';
  import { connectLive, disconnectLive, liveState } from './lib/live.svelte';
  import {
    logout,
    logoutEverywhere,
    PERMISSION_META,
    permissionsSummary,
    pushDensityPref,
    pushThemePref,
    refreshSession,
    sessionState,
    type Permissions,
  } from './lib/session.svelte';
  import {
    confirmDialog,
    densityState,
    initDensity,
    initTheme,
    openHelp,
    openPalette,
    setActiveTab,
    setDensity,
    setTheme,
    tabState,
    themePrefState,
    themeState,
    type TabId,
  } from './lib/ui.svelte';

  import Docs from './tabs/Docs.svelte';
  import Home from './tabs/Home.svelte';
  import Insights from './tabs/Insights.svelte';
  import Keys from './tabs/Keys.svelte';
  import Logs from './tabs/Logs.svelte';
  import Settings from './tabs/Settings.svelte';

  initTheme();
  initDensity();

  let homeRef: Home | undefined = $state();
  let loggingOut = $state(false);
  let loggingOutEverywhere = $state(false);
  let myPermsOpen = $state(false);

  const myGrantedPermissions = $derived(
    PERMISSION_META.filter((f) => sessionState.permissions?.[f.key] && !f.impliedBy?.some((k) => sessionState.permissions?.[k])).map(
      (f) => f.label,
    ),
  );

  type NotifPermission = NotificationPermission | 'unsupported';
  let notifPermission = $state<NotifPermission>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

  async function enableNotifications(): Promise<void> {
    if (typeof Notification === 'undefined') return;
    notifPermission = await Notification.requestPermission();
  }

  const TABS: { id: TabId; label: string; requires?: (keyof Permissions)[] }[] = [
    { id: 'home', label: 'Home' },
    { id: 'keys', label: 'API Keys', requires: ['decrypt', 'viewApiKeys', 'approveApiKeys', 'revokeApiKeys'] },
    { id: 'logs', label: 'Logs', requires: ['viewLogs'] },
    { id: 'insights', label: 'Insights' },
    { id: 'docs', label: 'Docs' },
    {
      id: 'settings',
      label: 'Settings',
      requires: ['manageScheduler', 'triggerDispatch', 'manageAppleAuth', 'viewUsers', 'manageUsers'],
    },
  ];

  const visibleTabs = $derived(
    TABS.filter((t) => !t.requires || t.requires.some((p) => sessionState.permissions?.[p])),
  );

  async function doLogout(): Promise<void> {
    loggingOut = true;
    try {
      await logout();
    } finally {
      loggingOut = false;
    }
  }

  async function doLogoutEverywhere(): Promise<void> {
    if (!(await confirmDialog('Sign out every device and browser signed in as you, including this one?', { confirmLabel: 'Log out everywhere' })))
      return;
    loggingOutEverywhere = true;
    try {
      await logoutEverywhere();
    } finally {
      loggingOutEverywhere = false;
    }
  }

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

  const BASE_TITLE = 'dkrypt';

  $effect(() => {
    if (!sessionState.loggedIn) {
      document.title = BASE_TITLE;
      return;
    }
    const active = liveState.overview?.activeJobs.length ?? 0;
    const failed = myDecryptsState.items.filter((d) => d.status === 'failed').length;
    const count = active + failed;
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
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
      return;
    }
    if (e.key === '?' && !typingInField) {
      e.preventDefault();
      openHelp();
    }
  }

  const THEME_CYCLE = ['dark', 'light', 'auto'] as const;

  function cycleTheme(): void {
    const next = THEME_CYCLE[(THEME_CYCLE.indexOf(themePrefState.value) + 1) % THEME_CYCLE.length];
    setTheme(next);
    void pushThemePref(next);
  }

  function toggleDensity(): void {
    const next = densityState.value === 'compact' ? 'comfortable' : 'compact';
    setDensity(next);
    void pushDensityPref(next);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<Toaster theme={themeState.value} richColors position="bottom-right" />

{#if !sessionState.loggedIn}
  <Login />
{:else}
  <div class="min-h-screen">
    <header class="border-border flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
      <div class="flex items-center gap-3">
        <h1 class="text-[15px] font-semibold">dkrypt</h1>
      </div>
      <div class="flex items-center gap-2.5">
        <a
          href={REPO_URL}
          target="_blank"
          rel="noopener noreferrer"
          class={buttonVariants('secondary', 'icon')}
          aria-label="View source on GitHub"
          title="View source on GitHub"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path
              d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z"
            />
          </svg>
        </a>
        <a
          href={KOFI_URL}
          target="_blank"
          rel="noopener noreferrer"
          class={buttonVariants('secondary', 'icon')}
          aria-label="Support on Ko-fi"
          title="Support on Ko-fi"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path
              d="M11.351 2.715c-2.7 0-4.986.025-6.83.26C2.078 3.285 0 5.154 0 8.61c0 3.506.182 6.13 1.585 8.493 1.584 2.701 4.233 4.182 7.662 4.182h.83c4.209 0 6.494-2.234 7.637-4a9.5 9.5 0 0 0 1.091-2.338C21.792 14.688 24 12.22 24 9.208v-.415c0-3.247-2.13-5.507-5.792-5.87-1.558-.156-2.65-.208-6.857-.208m0 1.947c4.208 0 5.09.052 6.571.182 2.624.311 4.13 1.584 4.13 4v.39c0 2.156-1.792 3.844-3.87 3.844h-.935l-.156.649c-.208 1.013-.597 1.818-1.039 2.546-.909 1.428-2.545 3.064-5.922 3.064h-.805c-2.571 0-4.831-.883-6.078-3.195-1.09-2-1.298-4.155-1.298-7.506 0-2.181.857-3.402 3.012-3.714 1.533-.233 3.559-.26 6.39-.26m6.547 2.287c-.416 0-.65.234-.65.546v2.935c0 .311.234.545.65.545 1.324 0 2.051-.754 2.051-2s-.727-2.026-2.052-2.026m-10.39.182c-1.818 0-3.013 1.48-3.013 3.142 0 1.533.858 2.857 1.949 3.897.727.701 1.87 1.429 2.649 1.896a1.47 1.47 0 0 0 1.507 0c.78-.467 1.922-1.195 2.623-1.896 1.117-1.039 1.974-2.364 1.974-3.897 0-1.662-1.247-3.142-3.039-3.142-1.065 0-1.792.545-2.338 1.298-.493-.753-1.246-1.298-2.312-1.298"
            />
          </svg>
        </a>
        <Button
          variant="secondary"
          size="icon"
          onclick={cycleTheme}
          aria-label="Theme: {themePrefState.value} (click to cycle)"
          title="Theme: {themePrefState.value} (click to cycle)"
        >
          {#if themePrefState.value === 'auto'}
            <Monitor class="h-4 w-4" />
          {:else if themePrefState.value === 'light'}
            <Sun class="h-4 w-4" />
          {:else}
            <Moon class="h-4 w-4" />
          {/if}
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onclick={toggleDensity}
          aria-label="Toggle compact table rows"
          title={densityState.value === 'compact' ? 'Switch to comfortable rows' : 'Switch to compact rows'}
        >
          {#if densityState.value === 'compact'}
            <Rows2 class="h-4 w-4" />
          {:else}
            <Rows3 class="h-4 w-4" />
          {/if}
        </Button>
        <NotificationBell />
        <button
          type="button"
          class="max-w-[40vw] cursor-pointer truncate text-[13px] text-muted hover:text-text sm:max-w-[55vw]"
          onclick={() => (myPermsOpen = true)}
          title="View your permissions"
        >
          {sessionState.sub} ({permissionsSummary(sessionState.permissions)})
        </button>
        <Button variant="secondary" size="sm" loading={loggingOut} onclick={doLogout}>Log out</Button>
      </div>
    </header>
    <main class="mx-auto max-w-[1680px] px-4 py-6 lg:px-6">
      <SessionExpiryBanner />
      <ConnectionBanner />
      <AlertBanner />
      <SetupBanner />
      <Tabs items={visibleTabs.map((t) => ({ id: t.id, label: t.label }))} value={tabState.active} onValueChange={(v) => setActiveTab(v as TabId)} class="mb-5" />

      <div class:hidden={tabState.active !== 'home'}>
        <Home bind:this={homeRef} />
      </div>
      <div class:hidden={tabState.active !== 'keys'}>
        <Keys />
      </div>
      {#if sessionState.permissions?.viewLogs}
        <div class:hidden={tabState.active !== 'logs'}>
          <Logs />
        </div>
      {/if}
      <div class:hidden={tabState.active !== 'insights'}>
        <Insights />
      </div>
      <div class:hidden={tabState.active !== 'docs'}>
        <Docs />
      </div>
      {#if sessionState.permissions?.manageScheduler || sessionState.permissions?.triggerDispatch || sessionState.permissions?.manageAppleAuth || sessionState.permissions?.viewUsers || sessionState.permissions?.manageUsers}
        <div class:hidden={tabState.active !== 'settings'}>
          <Settings />
        </div>
      {/if}
    </main>
  </div>
{/if}

<ConfirmModal />
<CommandPalette />
<ShortcutsHelp />

<Dialog open={myPermsOpen} onOpenChange={(v) => (myPermsOpen = v)} class="max-w-sm">
  <div class="mb-3 text-sm font-medium">Your permissions</div>
  <div class="mb-3 text-xs text-muted">Signed in as {sessionState.sub}</div>
  {#if myGrantedPermissions.length === 0}
    <div class="text-sm text-muted">Read-only - no permissions granted yet.</div>
  {:else}
    <div class="flex flex-wrap gap-1.5">
      {#each myGrantedPermissions as label (label)}
        <Badge variant="default">{label}</Badge>
      {/each}
    </div>
  {/if}
  <div class="border-border mt-4 border-t pt-4">
    <div class="flex items-center justify-between gap-3">
      <div class="text-[13px]">Desktop notifications</div>
      {#if notifPermission === 'granted'}
        <Badge variant="success">Enabled</Badge>
      {:else if notifPermission === 'denied'}
        <Badge variant="destructive" title="Blocked by your browser - check site settings">Blocked</Badge>
      {:else if notifPermission === 'unsupported'}
        <Badge variant="secondary">Not supported</Badge>
      {:else}
        <Button size="sm" variant="secondary" onclick={enableNotifications}>Enable</Button>
      {/if}
    </div>
    <div class="mt-1.5 text-xs text-muted">Get notified when your queued decrypts finish, even in a background tab.</div>
  </div>
  <div class="border-border mt-4 border-t pt-4">
    <Button variant="destructive" size="sm" class="w-full" loading={loggingOutEverywhere} onclick={doLogoutEverywhere}>
      Log out everywhere
    </Button>
    <div class="mt-1.5 text-xs text-muted">Signs out every session for {sessionState.sub}, including this one.</div>
  </div>
</Dialog>
