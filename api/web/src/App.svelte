<script lang="ts">
  import { DropdownMenu } from 'bits-ui';
  import { LogOut, Monitor, Moon, Rows2, Rows3, Sun, Volume2, VolumeX } from 'lucide-svelte';
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
  import Tabs from './lib/components/ui/Tabs.svelte';
  import { buttonVariants } from './lib/components/ui/variants';
  import { KOFI_URL, REPO_URL } from './lib/constants';
  import { myDecryptsState } from './lib/decrypts.svelte';
  import { connectLive, disconnectLive, liveState } from './lib/live.svelte';
  import { disablePush, enablePush, getExistingPushSubscription, pushSupported, registerServiceWorker } from './lib/push';
  import { PermissionFlag } from './lib/permissions';
  import {
    logout,
    logoutEverywhere,
    permissionsSummary,
    pushAccentPref,
    pushDensityPref,
    fetchNotificationPrefs,
    pushNotificationPrefs,
    pushThemePref,
    refreshSession,
    sessionBits,
    sessionCanSeeSettings,
    sessionHasAnyPermission,
    sessionHasPermission,
    sessionPermissionLabels,
    sessionState,
  } from './lib/session.svelte';
  import { testPush } from './lib/api';
  import {
    ACCENT_PRESETS,
    accentState,
    confirmDialog,
    densityState,
    initAccent,
    initDensity,
    initTheme,
    initUrlTabSync,
    openHelp,
    openPalette,
    setAccent,
    setActiveTab,
    setDensity,
    setSoundEnabled,
    setTheme,
    showToast,
    soundEnabledState,
    tabState,
    themePrefState,
    themeState,
    type TabId,
  } from './lib/ui.svelte';

  import Docs from './tabs/Docs.svelte';
  import Home from './tabs/Home.svelte';
  import StatusPanel from './tabs/home/StatusPanel.svelte';
  import Insights from './tabs/Insights.svelte';
  import Keys from './tabs/Keys.svelte';
  import Logs from './tabs/Logs.svelte';
  import Settings from './tabs/Settings.svelte';

  initTheme();
  initDensity();
  initAccent();
  initUrlTabSync();

  let homeRef: Home | undefined = $state();
  let loggingOut = $state(false);
  let loggingOutEverywhere = $state(false);
  let accountMenuOpen = $state(false);

  const otherOnlineUsers = $derived(liveState.onlineUsers.filter((u) => u !== sessionState.sub));

  function initials(name: string): string {
    return name.slice(0, 2).toUpperCase();
  }

  const myGrantedPermissions = $derived(sessionPermissionLabels());

  type NotifPermission = NotificationPermission | 'unsupported';
  let notifPermission = $state<NotifPermission>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  let pushEnabled = $state(false);
  let enablingPush = $state(false);
  let sendingTestPush = $state(false);
  let pushOnSuccess = $state(true);
  let pushOnFailure = $state(true);

  void registerServiceWorker();

  $effect(() => {
    if (sessionState.loggedIn && pushSupported()) {
      void getExistingPushSubscription().then((sub) => (pushEnabled = !!sub));
      void fetchNotificationPrefs().then((prefs) => {
        pushOnSuccess = prefs.pushOnSuccess ?? true;
        pushOnFailure = prefs.pushOnFailure ?? true;
      });
    }
  });

  async function togglePushOnSuccess(): Promise<void> {
    await pushNotificationPrefs({ pushOnSuccess });
  }

  async function togglePushOnFailure(): Promise<void> {
    await pushNotificationPrefs({ pushOnFailure });
  }

  async function enableNotifications(): Promise<void> {
    if (typeof Notification === 'undefined') return;
    notifPermission = await Notification.requestPermission();
    if (notifPermission !== 'granted' || !pushSupported()) return;
    enablingPush = true;
    try {
      pushEnabled = await enablePush();
    } catch {
      showToast("Couldn't enable push notifications - try again", 'error');
    } finally {
      enablingPush = false;
    }
  }

  async function disableNotifications(): Promise<void> {
    enablingPush = true;
    try {
      await disablePush();
      pushEnabled = false;
    } finally {
      enablingPush = false;
    }
  }

  async function sendTestPush(): Promise<void> {
    sendingTestPush = true;
    try {
      await testPush();
    } finally {
      sendingTestPush = false;
    }
  }

  const TABS: { id: TabId; label: string; requires?: bigint[] }[] = [
    { id: 'home', label: 'Home' },
    {
      id: 'keys',
      label: 'API Keys',
      requires: [PermissionFlag.requestDecrypt, PermissionFlag.viewApiKeys, PermissionFlag.approveApiKeys, PermissionFlag.revokeApiKeys],
    },
    { id: 'logs', label: 'Logs', requires: [PermissionFlag.viewLogs] },
    { id: 'insights', label: 'Insights' },
    { id: 'docs', label: 'Docs' },
    { id: 'settings', label: 'Settings' },
  ];

  const visibleTabs = $derived(
    TABS.filter((t) => {
      if (t.id === 'settings') return sessionCanSeeSettings();
      return !t.requires || sessionHasAnyPermission(t.requires);
    }),
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

  const TAB_JUMP_KEYS: Record<string, TabId> = { h: 'home', k: 'keys', l: 'logs', i: 'insights', d: 'docs', s: 'settings' };
  let awaitingTabJump = $state(false);
  let tabJumpTimer: ReturnType<typeof setTimeout> | undefined;

  function onKeydown(e: KeyboardEvent): void {
    const typingInField = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement)?.tagName ?? '');
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
      return;
    }
    if (awaitingTabJump) {
      awaitingTabJump = false;
      clearTimeout(tabJumpTimer);
      const target = TAB_JUMP_KEYS[e.key.toLowerCase()];
      if (target && visibleTabs.some((t) => t.id === target)) {
        e.preventDefault();
        setActiveTab(target);
      }
      return;
    }
    if (e.key === 'g' && !typingInField) {
      e.preventDefault();
      awaitingTabJump = true;
      tabJumpTimer = setTimeout(() => (awaitingTabJump = false), 900);
      return;
    }
    if (e.key === '/' && !typingInField && tabState.active === 'home') {
      e.preventDefault();
      homeRef?.focusSearch();
      return;
    }
    if (e.key === 'b' && !typingInField && tabState.active === 'home') {
      e.preventDefault();
      homeRef?.openBatch();
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

  function chooseAccent(id: string): void {
    setAccent(id);
    void pushAccentPref(id);
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
        <DropdownMenu.Root bind:open={accountMenuOpen}>
          <DropdownMenu.Trigger
            class="border-border hover:border-accent relative h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-full border"
            aria-label="Account menu"
            title={sessionState.sub}
          >
            {#if sessionState.sub === 'root'}
              <div class="bg-panel-muted text-muted flex h-full w-full items-center justify-center text-[11px] font-medium">
                {initials(sessionState.sub)}
              </div>
            {:else}
              <img src="https://github.com/{sessionState.sub}.png?size=64" alt="" class="h-full w-full object-cover" />
            {/if}
            {#if otherOnlineUsers.length > 0}
              <span class="bg-ok border-panel absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full border-2"></span>
            {/if}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              class="border-border bg-panel z-50 w-72 rounded-xl border p-3 shadow-2xl"
              sideOffset={8}
              align="end"
            >
              <div class="mb-1 truncate text-sm font-medium">{sessionState.sub}</div>
              <div class="mb-3 text-xs text-muted">{permissionsSummary(sessionBits())}</div>
              {#if myGrantedPermissions.length > 0}
                <div class="mb-3 flex flex-wrap gap-1.5">
                  {#each myGrantedPermissions as label (label)}
                    <Badge variant="default">{label}</Badge>
                  {/each}
                </div>
              {/if}

              {#if otherOnlineUsers.length > 0}
                <div class="border-border mb-3 border-t pt-3">
                  <div class="mb-1.5 text-[11px] text-muted">{otherOnlineUsers.length} other{otherOnlineUsers.length === 1 ? '' : 's'} online</div>
                  <div class="flex flex-wrap gap-1">
                    {#each otherOnlineUsers as u (u)}
                      <Badge variant="secondary" title={u}>{u}</Badge>
                    {/each}
                  </div>
                </div>
              {/if}

              <div class="border-border mb-3 border-t pt-3">
                <div class="mb-1.5 flex items-center justify-between gap-3">
                  <div class="text-[13px]">Job-completion sound</div>
                  <Button
                    variant="secondary"
                    size="icon"
                    onclick={() => setSoundEnabled(!soundEnabledState.value)}
                    aria-label="Toggle job-completion sound"
                    title={soundEnabledState.value ? 'Sound on - click to mute' : 'Sound off - click to enable'}
                  >
                    {#if soundEnabledState.value}
                      <Volume2 class="h-4 w-4" />
                    {:else}
                      <VolumeX class="h-4 w-4" />
                    {/if}
                  </Button>
                </div>
                <div class="mb-1.5 text-[11px] text-muted">Accent color</div>
                <div class="flex flex-wrap gap-1.5">
                  {#each ACCENT_PRESETS as preset (preset.id)}
                    <button
                      type="button"
                      class="h-5 w-5 cursor-pointer rounded-full border-2"
                      style="background-color: {themeState.value === 'light' ? preset.light : preset.dark}; border-color: {accentState.value === preset.id ? 'var(--color-text)' : 'transparent'};"
                      onclick={() => chooseAccent(preset.id)}
                      aria-label="Accent: {preset.label}"
                      title={preset.label}
                    ></button>
                  {/each}
                </div>
              </div>

              <div class="border-border mb-3 border-t pt-3">
                <div class="flex items-center justify-between gap-3">
                  <div class="text-[13px]">Notifications</div>
                  {#if notifPermission === 'granted' && pushEnabled}
                    <Badge variant="success">Enabled</Badge>
                  {:else if notifPermission === 'denied'}
                    <Badge variant="destructive" title="Blocked by your browser - check site settings">Blocked</Badge>
                  {:else if notifPermission === 'unsupported'}
                    <Badge variant="secondary">Not supported</Badge>
                  {:else}
                    <Button size="sm" variant="secondary" loading={enablingPush} onclick={enableNotifications}>Enable</Button>
                  {/if}
                </div>
                <div class="mt-1.5 text-xs text-muted">
                  {#if pushSupported()}
                    Get notified when your queued decrypts finish - even in a background tab, or with the browser closed entirely.
                  {:else}
                    Get notified when your queued decrypts finish, even in a background tab. Push (works with the browser closed) isn't supported here.
                  {/if}
                </div>
                {#if notifPermission === 'granted' && pushEnabled}
                  <div class="mt-2 flex gap-2">
                    <Button size="sm" variant="secondary" loading={sendingTestPush} onclick={sendTestPush}>Send test</Button>
                    <Button size="sm" variant="secondary" loading={enablingPush} onclick={disableNotifications}>Disable push</Button>
                  </div>
                  <div class="mt-2.5 flex flex-col gap-1.5 text-xs text-muted">
                    <label class="inline-flex items-center gap-1.5">
                      <input type="checkbox" bind:checked={pushOnSuccess} onchange={togglePushOnSuccess} />
                      Notify me on successful decrypts
                    </label>
                    <label class="inline-flex items-center gap-1.5">
                      <input type="checkbox" bind:checked={pushOnFailure} onchange={togglePushOnFailure} />
                      Notify me on failed decrypts
                    </label>
                  </div>
                {/if}
              </div>

              <div class="border-border flex flex-col gap-1.5 border-t pt-3">
                <Button variant="secondary" size="sm" class="w-full justify-start" loading={loggingOut} onclick={doLogout}>
                  <LogOut class="h-3.5 w-3.5" />
                  Log out
                </Button>
                <Button variant="destructive" size="sm" class="w-full" loading={loggingOutEverywhere} onclick={doLogoutEverywhere}>
                  Log out everywhere
                </Button>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
    </header>
    <main class="mx-auto max-w-[1680px] px-4 py-6 lg:px-6">
      <SessionExpiryBanner />
      <ConnectionBanner />
      <AlertBanner />
      <SetupBanner />
      <div class="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div class="min-w-0">
          <Tabs items={visibleTabs.map((t) => ({ id: t.id, label: t.label }))} value={tabState.active} onValueChange={(v) => setActiveTab(v as TabId)} class="mb-5" />

          <div class:hidden={tabState.active !== 'home'}>
            <Home bind:this={homeRef} />
          </div>
          <div class:hidden={tabState.active !== 'keys'}>
            <Keys />
          </div>
          {#if sessionHasPermission(PermissionFlag.viewLogs)}
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
          {#if sessionCanSeeSettings()}
            <div class:hidden={tabState.active !== 'settings'}>
              <Settings />
            </div>
          {/if}
        </div>
        <div class="flex flex-col gap-4 lg:sticky lg:top-6">
          <StatusPanel />
        </div>
      </div>
    </main>
  </div>
{/if}

<ConfirmModal />
<CommandPalette />
<ShortcutsHelp />
