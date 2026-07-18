<script lang="ts">
  import Tabs from '../lib/components/ui/Tabs.svelte';
  import { sessionState, type Permissions } from '../lib/session.svelte';
  import { setSettingsSubtab, tabState } from '../lib/ui.svelte';
  import AppleAuthSettings from './settings/AppleAuthSettings.svelte';
  import BackupSettings from './settings/BackupSettings.svelte';
  import DevicesSettings from './settings/DevicesSettings.svelte';
  import SchedulerSettings from './settings/SchedulerSettings.svelte';
  import UsersSettings from './settings/UsersSettings.svelte';

  const ALL_SUBTABS: { id: string; label: string; requires: (keyof Permissions)[] }[] = [
    { id: 'scheduler', label: 'Scheduler', requires: ['manageScheduler', 'triggerDispatch'] },
    { id: 'devices', label: 'Devices', requires: ['manageScheduler'] },
    { id: 'users', label: 'Users', requires: ['viewUsers', 'manageUsers'] },
    { id: 'apple', label: 'Apple Auth', requires: ['manageAppleAuth'] },
    { id: 'backup', label: 'Backup', requires: ['manageUsers'] },
  ];

  function hasAccess(requires: (keyof Permissions)[]): boolean {
    return requires.some((p) => sessionState.permissions?.[p]);
  }

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((t) => hasAccess(t.requires)));

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });
</script>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if hasAccess(['manageScheduler', 'triggerDispatch'])}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if hasAccess(['manageScheduler'])}
  <div class:hidden={tabState.settingsSubtab !== 'devices'}>
    <DevicesSettings />
  </div>
{/if}
{#if hasAccess(['viewUsers', 'manageUsers'])}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if hasAccess(['manageAppleAuth'])}
  <div class:hidden={tabState.settingsSubtab !== 'apple'}>
    <AppleAuthSettings />
  </div>
{/if}
{#if hasAccess(['manageUsers'])}
  <div class:hidden={tabState.settingsSubtab !== 'backup'}>
    <BackupSettings />
  </div>
{/if}
