<script lang="ts">
  import Tabs from '../lib/components/ui/Tabs.svelte';
  import { sessionState, type Permissions } from '../lib/session.svelte';
  import { setSettingsSubtab, tabState } from '../lib/ui.svelte';
  import AppleAuthSettings from './settings/AppleAuthSettings.svelte';
  import SchedulerSettings from './settings/SchedulerSettings.svelte';
  import UsersSettings from './settings/UsersSettings.svelte';

  const ALL_SUBTABS: { id: string; label: string; requires: (keyof Permissions)[] }[] = [
    { id: 'scheduler', label: 'Scheduler', requires: ['manageSettings'] },
    { id: 'users', label: 'Users', requires: ['manageUsers'] },
    { id: 'apple', label: 'Apple Auth', requires: ['manageSettings', 'manageUsers'] },
  ];

  function hasAccess(requires: (keyof Permissions)[]): boolean {
    return requires.every((p) => sessionState.permissions?.[p]);
  }

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((t) => hasAccess(t.requires)));

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });
</script>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if hasAccess(['manageSettings'])}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if hasAccess(['manageUsers'])}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if hasAccess(['manageSettings', 'manageUsers'])}
  <div class:hidden={tabState.settingsSubtab !== 'apple'}>
    <AppleAuthSettings />
  </div>
{/if}
