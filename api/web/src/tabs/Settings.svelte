<script lang="ts">
  import Tabs from '../lib/components/ui/Tabs.svelte';
  import { sessionState } from '../lib/session.svelte';
  import { setSettingsSubtab, tabState } from '../lib/ui.svelte';
  import AppleAuthSettings from './settings/AppleAuthSettings.svelte';
  import SchedulerSettings from './settings/SchedulerSettings.svelte';
  import UsersSettings from './settings/UsersSettings.svelte';

  const ALL_SUBTABS = [
    { id: 'scheduler', label: 'Scheduler', requires: 'manageSettings' as const },
    { id: 'users', label: 'Users', requires: 'manageUsers' as const },
    { id: 'apple', label: 'Apple Auth', requires: 'manageSettings' as const },
  ];

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((t) => sessionState.permissions?.[t.requires]));

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });
</script>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if sessionState.permissions?.manageSettings}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if sessionState.permissions?.manageUsers}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if sessionState.permissions?.manageSettings}
  <div class:hidden={tabState.settingsSubtab !== 'apple'}>
    <AppleAuthSettings />
  </div>
{/if}
