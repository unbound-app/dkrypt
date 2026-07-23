<script lang="ts">
  import Tabs from '../lib/components/ui/Tabs.svelte';
  import { PermissionFlag } from '../lib/permissions';
  import { sessionHasAnyPermission } from '../lib/session.svelte';
  import { setSettingsSubtab, tabState } from '../lib/ui.svelte';
  import AppleAuthSettings from './settings/AppleAuthSettings.svelte';
  import BackupSettings from './settings/BackupSettings.svelte';
  import DevicesSettings from './settings/DevicesSettings.svelte';
  import RolesSettings from './settings/RolesSettings.svelte';
  import SchedulerSettings from './settings/SchedulerSettings.svelte';
  import UsersSettings from './settings/UsersSettings.svelte';

  const ALL_SUBTABS: { id: string; label: string; requires: bigint[] }[] = [
    { id: 'scheduler', label: 'Automation', requires: [PermissionFlag.viewScheduler, PermissionFlag.manageWatches, PermissionFlag.manageSchedulerSettings, PermissionFlag.triggerDispatch] },
    { id: 'devices', label: 'Devices', requires: [PermissionFlag.viewDevices, PermissionFlag.manageDevices] },
    { id: 'users', label: 'Users', requires: [PermissionFlag.viewUsers, PermissionFlag.manageUsers] },
    { id: 'roles', label: 'Roles', requires: [PermissionFlag.viewRoles, PermissionFlag.manageRoles, PermissionFlag.viewDiscordPerks, PermissionFlag.manageDiscordPerks] },
    { id: 'apple', label: 'Apple Auth', requires: [PermissionFlag.manageAppleAuth] },
    { id: 'backup', label: 'Backup', requires: [PermissionFlag.viewBackup, PermissionFlag.manageBackup] },
  ];

  function hasAccess(requires: bigint[]): boolean {
    return sessionHasAnyPermission(requires);
  }

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((t) => hasAccess(t.requires)));

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });
</script>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if hasAccess([PermissionFlag.viewScheduler, PermissionFlag.manageWatches, PermissionFlag.manageSchedulerSettings, PermissionFlag.triggerDispatch])}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewDevices, PermissionFlag.manageDevices])}
  <div class:hidden={tabState.settingsSubtab !== 'devices'}>
    <DevicesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewUsers, PermissionFlag.manageUsers])}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewRoles, PermissionFlag.manageRoles, PermissionFlag.viewDiscordPerks, PermissionFlag.manageDiscordPerks])}
  <div class:hidden={tabState.settingsSubtab !== 'roles'}>
    <RolesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageAppleAuth])}
  <div class:hidden={tabState.settingsSubtab !== 'apple'}>
    <AppleAuthSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewBackup, PermissionFlag.manageBackup])}
  <div class:hidden={tabState.settingsSubtab !== 'backup'}>
    <BackupSettings />
  </div>
{/if}
