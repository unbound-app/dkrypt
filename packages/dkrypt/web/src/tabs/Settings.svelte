<script lang="ts">
  import Tabs from '#lib/components/ui/Tabs.svelte';
  import { PermissionFlag } from '#lib/permissions';
  import { sessionHasAnyPermission, sessionHasPermission } from '#lib/session.svelte';
  import { setSettingsSubtab, tabState } from '#lib/ui.svelte';
  import { createVisitedTabs } from '#lib/visitedTabs.svelte';
  import BackupSettings from '#tabs/settings/BackupSettings.svelte';
  import BillingSettings from '#tabs/settings/BillingSettings.svelte';
  import ArtifactStorageSettings from '#tabs/settings/ArtifactStorageSettings.svelte';
  import DevicesSettings from '#tabs/settings/DevicesSettings.svelte';
  import ProjectsSettings from '#tabs/settings/ProjectsSettings.svelte';
  import RolesSettings from '#tabs/settings/RolesSettings.svelte';
  import SchedulerSettings from '#tabs/settings/SchedulerSettings.svelte';
  import SystemDoctorSettings from '#tabs/settings/SystemDoctorSettings.svelte';
  import TestFlightSettings from '#tabs/settings/TestFlightSettings.svelte';
  import UsersSettings from '#tabs/settings/UsersSettings.svelte';

  const ALL_SUBTABS: { id: string; label: string; requires: bigint[]; requiresAll?: bigint[] }[] = [
    { id: 'scheduler', label: 'Automation', requires: [PermissionFlag.viewAutomation, PermissionFlag.manageAutomation] },
    { id: 'storage', label: 'Storage', requires: [PermissionFlag.manageAutomation], requiresAll: [PermissionFlag.requestDecrypt] },
    { id: 'devices', label: 'Devices', requires: [PermissionFlag.viewDevices, PermissionFlag.manageDevices] },
    { id: 'doctor', label: 'System', requires: [PermissionFlag.manageDevices] },
    { id: 'users', label: 'Users', requires: [PermissionFlag.viewUsers, PermissionFlag.manageUsers] },
    { id: 'roles', label: 'Roles', requires: [PermissionFlag.viewRoles, PermissionFlag.manageRoles] },
    { id: 'projects', label: 'Projects', requires: [PermissionFlag.viewProjects, PermissionFlag.manageProjects] },
    { id: 'backup', label: 'Backup', requires: [PermissionFlag.viewBackup, PermissionFlag.manageBackup] },
    { id: 'testflight', label: 'TestFlight', requires: [PermissionFlag.manageTestFlightSubscriptions] },
    { id: 'billing', label: 'Billing', requires: [PermissionFlag.viewBilling, PermissionFlag.manageBilling] },
  ];

  function hasAccess(requires: bigint[], requiresAll: bigint[] = []): boolean {
    return sessionHasAnyPermission(requires) && requiresAll.every(sessionHasPermission);
  }

  const visibleSubtabs = $derived(ALL_SUBTABS.filter((subtab) => hasAccess(subtab.requires, subtab.requiresAll)));
  const mountedSubtabs = createVisitedTabs(() => tabState.settingsSubtab);

  $effect(() => {
    if (visibleSubtabs.length > 0 && !visibleSubtabs.some((t) => t.id === tabState.settingsSubtab)) {
      setSettingsSubtab(visibleSubtabs[0].id);
    }
  });

</script>

<Tabs items={visibleSubtabs} value={tabState.settingsSubtab} onValueChange={setSettingsSubtab} class="mb-5" />

{#if hasAccess([PermissionFlag.viewAutomation, PermissionFlag.manageAutomation]) && mountedSubtabs.scheduler}
  <div class:hidden={tabState.settingsSubtab !== 'scheduler'}>
    <SchedulerSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageAutomation], [PermissionFlag.requestDecrypt]) && mountedSubtabs.storage}
  <div class:hidden={tabState.settingsSubtab !== 'storage'}>
    <ArtifactStorageSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewDevices, PermissionFlag.manageDevices]) && mountedSubtabs.devices}
  <div class:hidden={tabState.settingsSubtab !== 'devices'}>
    <DevicesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageDevices]) && mountedSubtabs.doctor}
  <div class:hidden={tabState.settingsSubtab !== 'doctor'}>
    <SystemDoctorSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewUsers, PermissionFlag.manageUsers]) && mountedSubtabs.users}
  <div class:hidden={tabState.settingsSubtab !== 'users'}>
    <UsersSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewRoles, PermissionFlag.manageRoles]) && mountedSubtabs.roles}
  <div class:hidden={tabState.settingsSubtab !== 'roles'}>
    <RolesSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewProjects, PermissionFlag.manageProjects]) && mountedSubtabs.projects}
  <div class:hidden={tabState.settingsSubtab !== 'projects'}>
    <ProjectsSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewBackup, PermissionFlag.manageBackup]) && mountedSubtabs.backup}
  <div class:hidden={tabState.settingsSubtab !== 'backup'}>
    <BackupSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.manageTestFlightSubscriptions]) && mountedSubtabs.testflight}
  <div class:hidden={tabState.settingsSubtab !== 'testflight'}>
    <TestFlightSettings />
  </div>
{/if}
{#if hasAccess([PermissionFlag.viewBilling, PermissionFlag.manageBilling]) && mountedSubtabs.billing}
  <div class:hidden={tabState.settingsSubtab !== 'billing'}>
    <BillingSettings />
  </div>
{/if}
